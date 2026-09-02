alter table jobs add column if not exists lease_token text;

create index if not exists jobs_expired_lease_idx
  on jobs(stage, leased_at)
  where stage = 'running' and leased_at is not null;
