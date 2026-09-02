create table if not exists upload_sessions (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  principal_id text not null,
  bucket text not null,
  object_key text not null unique,
  provider_upload_id text not null,
  filename text not null,
  mime_type text,
  size_bytes bigint not null check (size_bytes > 0),
  part_size integer not null check (part_size > 0),
  part_count integer not null check (part_count > 0 and part_count <= 10000),
  settings jsonb not null,
  status text not null default 'active' check (status in ('active', 'completed', 'aborted', 'expired')),
  parts jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  completed_at timestamptz,
  job_id text
);

create index if not exists upload_sessions_workspace_idx
  on upload_sessions(workspace_id, created_at desc);
create index if not exists upload_sessions_expiry_idx
  on upload_sessions(status, expires_at);
