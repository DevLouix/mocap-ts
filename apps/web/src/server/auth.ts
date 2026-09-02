import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import type { Principal, WorkspacePermission, WorkspaceRole } from '@mocap-ts/core/identity';
import { canReviewWorkspace, canWriteWorkspace, hasWorkspaceRole } from '@mocap-ts/core/identity';

/** Error that route handlers can translate into a 401/403 response. */
export class AuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

const ALL_ROLES: WorkspaceRole[] = ['owner', 'admin', 'editor', 'reviewer', 'viewer'];

/**
 * Resolve the current principal from an upstream identity gateway.
 *
 * `MOCAP_AUTH_MODE=header` is intended for a trusted reverse proxy that has
 * already verified OIDC/SAML. Do not expose these headers directly to the
 * public internet. In development, `local` supplies a deterministic tenant
 * so the self-hosted app remains usable without an identity provider.
 */
export function principalFromHeaders(headers: Headers): Principal {
  const mode = process.env.MOCAP_AUTH_MODE
    ?? (process.env.NODE_ENV === 'production' ? 'required' : 'local');

  if (mode === 'local') {
    return {
      id: process.env.MOCAP_LOCAL_USER_ID ?? 'local-user',
      provider: 'local',
      displayName: 'Local user',
      organizationId: process.env.MOCAP_LOCAL_ORGANIZATION_ID ?? 'local-organization',
      workspaceId: process.env.MOCAP_LOCAL_WORKSPACE_ID ?? 'local-workspace',
      roles: ['owner'],
    };
  }

  if (mode !== 'header') {
    throw new AuthError(401, 'Authentication is required. Configure an identity provider for this deployment.');
  }

  const expectedSecret = process.env.MOCAP_AUTH_HEADER_SECRET;
  const suppliedSecret = headers.get('x-mocap-auth-secret');
  if (!expectedSecret || !suppliedSecret || !secretsEqual(suppliedSecret, expectedSecret)) {
    throw new AuthError(401, 'Authentication gateway verification failed.');
  }

  const id = headers.get('x-mocap-user-id')?.trim();
  const organizationId = headers.get('x-mocap-organization-id')?.trim();
  const workspaceId = headers.get('x-mocap-workspace-id')?.trim();
  if (!id || !organizationId || !workspaceId) {
    throw new AuthError(401, 'Missing authenticated workspace context.');
  }

  const roles = (headers.get('x-mocap-workspace-roles') ?? '')
    .split(',')
    .map(value => value.trim() as WorkspaceRole)
    .filter((role, index, values): role is WorkspaceRole => ALL_ROLES.includes(role) && values.indexOf(role) === index);
  if (roles.length === 0) throw new AuthError(403, 'Authenticated user has no workspace role.');

  return {
    id,
    provider: 'oidc',
    displayName: headers.get('x-mocap-user-name') ?? undefined,
    email: headers.get('x-mocap-user-email') ?? undefined,
    organizationId,
    workspaceId,
    roles,
    isServiceAccount: headers.get('x-mocap-service-account') === 'true',
  };
}

export function requirePermission(principal: Principal, permission: WorkspacePermission): void {
  const allowed = (() => {
    switch (permission) {
      case 'job:create':
      case 'asset:write':
      case 'project:write':
        return canWriteWorkspace(principal);
      case 'job:delete':
        return hasWorkspaceRole(principal, 'owner', 'admin');
      case 'job:cancel':
        return canWriteWorkspace(principal);
      case 'job:operate':
        return hasWorkspaceRole(principal, 'owner', 'admin');
      case 'review:write':
        return canReviewWorkspace(principal);
      case 'job:read':
      case 'job:download':
      case 'asset:read':
        return hasWorkspaceRole(principal, 'owner', 'admin', 'editor', 'reviewer', 'viewer');
    }
  })();
  if (!allowed) throw new AuthError(403, `Permission denied: ${permission}`);
}

export function requireJobWorkspace(principal: Principal, workspaceId: string, permission: WorkspacePermission): void {
  if (principal.workspaceId !== workspaceId || !workspaceId) {
    throw new AuthError(403, 'Job does not belong to the active workspace.');
  }
  requirePermission(principal, permission);
}

export function requestPrincipal(headers: Headers, permission?: WorkspacePermission): Principal {
  const principal = principalFromHeaders(headers);
  if (permission) requirePermission(principal, permission);
  return principal;
}

function secretsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authResponse(error: unknown): Response | null {
  if (!(error instanceof AuthError)) return null;
  return Response.json({ error: error.message }, { status: error.status });
}
