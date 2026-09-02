import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
  PutObjectCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export interface StorageOptions {
  endpoint?: string;
  region?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  /** Public endpoint used only in presigned browser URLs. */
  publicEndpoint?: string;
}

export interface ObjectAddress {
  bucket: string;
  key: string;
}

export interface UploadPart {
  partNumber: number;
  etag?: string;
  checksumSha256?: string;
  sizeBytes?: number;
}

export interface MultipartUpload {
  uploadId: string;
  address: ObjectAddress;
}

/** S3 and MinIO adapter. The application stores keys, never signed URLs. */
export class ObjectStorage {
  readonly client: S3Client;
  readonly presignClient: S3Client;
  readonly bucket: string;

  constructor(options: StorageOptions = {}) {
    this.bucket = options.bucket ?? process.env.S3_BUCKET ?? 'mocap';
    const endpoint = options.endpoint ?? process.env.S3_ENDPOINT;
    this.client = new S3Client({
      endpoint,
      region: options.region ?? process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: options.forcePathStyle ?? process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: options.accessKeyId && options.secretAccessKey
        ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
        : process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
    this.presignClient = options.publicEndpoint || process.env.S3_PUBLIC_ENDPOINT
      ? new S3Client({
          endpoint: options.publicEndpoint ?? process.env.S3_PUBLIC_ENDPOINT,
          region: options.region ?? process.env.S3_REGION ?? 'us-east-1',
          forcePathStyle: options.forcePathStyle ?? process.env.S3_FORCE_PATH_STYLE === 'true',
          credentials: options.accessKeyId && options.secretAccessKey
            ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
            : process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
              ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
              : undefined,
        })
      : this.client;
  }

  tenantKey(organizationId: string, workspaceId: string, assetId: string, filename?: string): string {
    for (const value of [organizationId, workspaceId, assetId]) {
      if (!/^[\w-]{1,128}$/.test(value)) throw new Error('Invalid storage identifier');
    }
    const suffix = filename ? sanitizeFilename(filename) : 'asset';
    return `organizations/${organizationId}/workspaces/${workspaceId}/assets/${assetId}/${suffix}`;
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      } catch (error) {
        // Another web/worker replica may have created it concurrently.
        try {
          await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
        } catch {
          throw error;
        }
      }
    }
  }

  async put(address: ObjectAddress, body: Uint8Array | Buffer, contentType: string): Promise<void> {
    validateAddress(address);
    await this.client.send(new PutObjectCommand({
      Bucket: address.bucket,
      Key: address.key,
      Body: body,
      ContentType: contentType,
    }));
  }

  async putStream(address: ObjectAddress, body: import('node:stream').Readable, contentType: string): Promise<void> {
    validateAddress(address);
    await this.client.send(new PutObjectCommand({
      Bucket: address.bucket,
      Key: address.key,
      Body: body,
      ContentType: contentType,
    }));
  }

  async head(address: ObjectAddress): Promise<{ contentLength?: number; contentType?: string; etag?: string } | null> {
    validateAddress(address);
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: address.bucket, Key: address.key }));
      return { contentLength: result.ContentLength, contentType: result.ContentType, etag: result.ETag };
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  }

  async downloadPrefix(address: ObjectAddress, length = 64): Promise<Uint8Array> {
    validateAddress(address);
    const end = Math.min(Math.max(length, 1), 1024) - 1;
    const result = await this.client.send(new GetObjectCommand({
      Bucket: address.bucket,
      Key: address.key,
      Range: `bytes=0-${end}`,
    }));
    if (!result.Body) throw new Error('Object storage returned an empty object body');
    const body = result.Body as unknown as { transformToByteArray?: () => Promise<Uint8Array> };
    if (typeof body.transformToByteArray !== 'function') {
      throw new Error('Object storage response does not expose a byte reader');
    }
    return body.transformToByteArray();
  }

  async downloadBytes(address: ObjectAddress): Promise<Uint8Array> {
    validateAddress(address);
    const result = await this.client.send(new GetObjectCommand({ Bucket: address.bucket, Key: address.key }));
    if (!result.Body) throw new Error('Object storage returned an empty object body');
    const body = result.Body as unknown as { transformToByteArray?: () => Promise<Uint8Array> };
    if (typeof body.transformToByteArray !== 'function') {
      throw new Error('Object storage response does not expose a byte reader');
    }
    return body.transformToByteArray();
  }

  async downloadToFile(address: ObjectAddress, destination: string): Promise<void> {
    validateAddress(address);
    const result = await this.client.send(new GetObjectCommand({ Bucket: address.bucket, Key: address.key }));
    if (!result.Body) throw new Error('Object storage returned an empty object body');
    const body = result.Body as unknown as { transformToWebStream?: () => ReadableStream<Uint8Array> };
    if (typeof body.transformToWebStream === 'function') {
      await pipeline(Readable.fromWeb(body.transformToWebStream() as import('node:stream/web').ReadableStream<Uint8Array>), createWriteStream(destination, { flags: 'wx' }));
      return;
    }
    throw new Error('Object storage response does not expose a readable stream');
  }

  async signedDownload(address: ObjectAddress, expiresInSeconds = 900): Promise<string> {
    validateAddress(address);
    return getSignedUrl(this.presignClient, new GetObjectCommand({ Bucket: address.bucket, Key: address.key }), {
      expiresIn: Math.min(Math.max(expiresInSeconds, 1), 3600),
    });
  }

  async beginMultipart(address: ObjectAddress, contentType: string): Promise<MultipartUpload> {
    validateAddress(address);
    const result = await this.client.send(new CreateMultipartUploadCommand({
      Bucket: address.bucket,
      Key: address.key,
      ContentType: contentType,
    }));
    if (!result.UploadId) throw new Error('Object storage did not return a multipart upload id');
    return { uploadId: result.UploadId, address };
  }

  async signedPartUpload(upload: MultipartUpload, partNumber: number, expiresInSeconds = 900): Promise<string> {
    validatePartNumber(partNumber);
    validateAddress(upload.address);
    return getSignedUrl(this.presignClient, new UploadPartCommand({
      Bucket: upload.address.bucket,
      Key: upload.address.key,
      UploadId: upload.uploadId,
      PartNumber: partNumber,
    }), { expiresIn: Math.min(Math.max(expiresInSeconds, 1), 3600) });
  }

  async listParts(upload: MultipartUpload): Promise<UploadPart[]> {
    validateAddress(upload.address);
    const parts: UploadPart[] = [];
    let marker: string | undefined;
    let truncated = true;
    while (truncated) {
      const result = await this.client.send(new ListPartsCommand({
        Bucket: upload.address.bucket,
        Key: upload.address.key,
        UploadId: upload.uploadId,
        PartNumberMarker: marker,
      }));
      for (const part of result.Parts ?? []) {
        const partNumber = part.PartNumber;
        if (typeof partNumber === 'number' && Number.isInteger(partNumber) && partNumber > 0) {
          parts.push({
            partNumber,
            etag: part.ETag,
            checksumSha256: part.ChecksumSHA256,
            sizeBytes: part.Size,
          });
        }
      }
      truncated = result.IsTruncated === true;
      marker = result.NextPartNumberMarker;
      if (truncated && marker == null) throw new Error('Object storage returned an invalid multipart page');
    }
    return parts;
  }

  async completeMultipart(upload: MultipartUpload, parts: UploadPart[]): Promise<void> {
    validateAddress(upload.address);
    const completed: CompletedPart[] = parts
      .sort((a, b) => a.partNumber - b.partNumber)
      .map(part => ({ PartNumber: part.partNumber, ETag: part.etag, ChecksumSHA256: part.checksumSha256 }));
    if (completed.length === 0) throw new Error('Multipart upload requires at least one part');
    await this.client.send(new CompleteMultipartUploadCommand({
      Bucket: upload.address.bucket,
      Key: upload.address.key,
      UploadId: upload.uploadId,
      MultipartUpload: { Parts: completed },
    }));
  }

  async abortMultipart(upload: MultipartUpload): Promise<void> {
    validateAddress(upload.address);
    await this.client.send(new AbortMultipartUploadCommand({
      Bucket: upload.address.bucket,
      Key: upload.address.key,
      UploadId: upload.uploadId,
    }));
  }

  async delete(address: ObjectAddress): Promise<void> {
    validateAddress(address);
    await this.client.send(new DeleteObjectCommand({ Bucket: address.bucket, Key: address.key }));
  }
}

export function createObjectStorage(options: StorageOptions = {}): ObjectStorage {
  return new ObjectStorage(options);
}

function validateAddress(address: ObjectAddress): void {
  if (!address.bucket || !address.key || address.key.startsWith('/') || address.key.includes('..')) {
    throw new Error('Invalid object address');
  }
}

function validatePartNumber(partNumber: number): void {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    throw new Error('Multipart part number must be between 1 and 10000');
  }
}

function sanitizeFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() ?? 'asset';
  return basename.replace(/[^\w.-]+/g, '_').slice(0, 120) || 'asset';
}
