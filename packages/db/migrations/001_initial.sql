create table if not exists organizations (
  id text primary key,
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists workspaces (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  name text not null,
  slug text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, slug)
);

create table if not exists workspace_memberships (
  workspace_id text not null references workspaces(id) on delete cascade,
  principal_id text not null,
  role text not null check (role in ('owner', 'admin', 'editor', 'reviewer', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, principal_id)
);

create table if not exists projects (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  slug text not null,
  description text,
  frame_rate numeric,
  unit text not null default 'meter' check (unit in ('centimeter', 'meter')),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);

create table if not exists assets (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  project_id text references projects(id) on delete cascade,
  object_key text not null unique,
  provider text not null,
  bucket text,
  content_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  checksum text,
  checksum_algorithm text,
  original_filename text,
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists jobs (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  project_id text references projects(id) on delete cascade,
  created_by text not null,
  source jsonb not null,
  settings jsonb not null,
  stage text not null,
  progress numeric not null default 0 check (progress >= 0 and progress <= 1),
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null default 3 check (max_attempts > 0),
  leased_at timestamptz,
  cancel_requested boolean not null default false,
  output_object_key text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists jobs_workspace_created_idx on jobs(workspace_id, created_at desc);
create index if not exists jobs_queue_idx on jobs(stage, leased_at);
create index if not exists assets_workspace_idx on assets(workspace_id, created_at desc);

create table if not exists audit_events (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  actor_id text not null,
  action text not null,
  resource_type text not null,
  resource_id text not null,
  outcome text not null check (outcome in ('success', 'denied', 'failure')),
  request_id text,
  metadata jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists audit_workspace_time_idx on audit_events(workspace_id, occurred_at desc);
