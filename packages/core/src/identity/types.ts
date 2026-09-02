/** Provider-neutral identity and tenant contracts.
 *
 * These contracts deliberately do not depend on an identity provider or ORM.
 * An OIDC/SAML adapter, local development adapter, or service-account adapter
 * can map its claims into these stable application concepts.
 */

export type IdentityProvider = 'local' | 'oidc' | 'saml' | 'service';

export type WorkspaceRole = 'owner' | 'admin' | 'editor' | 'reviewer' | 'viewer';

export interface Principal {
  id: string;
  provider: IdentityProvider;
  displayName?: string;
  email?: string;
  organizationId: string;
  workspaceId: string;
  roles: WorkspaceRole[];
  isServiceAccount?: boolean;
}

export interface WorkspaceMembership {
  principalId: string;
  organizationId: string;
  workspaceId: string;
  role: WorkspaceRole;
  createdAt: string;
}

export type WorkspacePermission =
  | 'job:create'
  | 'job:read'
  | 'job:cancel'
  | 'job:delete'
  | 'job:download'
  | 'job:operate'
  | 'asset:read'
  | 'asset:write'
  | 'project:write'
  | 'review:write';

export interface AuthorizationContext {
  principal: Principal;
  resourceWorkspaceId: string;
  permission: WorkspacePermission;
}

export interface AuditEvent {
  id: string;
  occurredAt: string;
  actorId: string;
  organizationId: string;
  workspaceId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  outcome: 'success' | 'denied' | 'failure';
  requestId?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export function hasWorkspaceRole(principal: Principal, ...roles: WorkspaceRole[]): boolean {
  return roles.some(role => principal.roles.includes(role));
}

export function canWriteWorkspace(principal: Principal): boolean {
  return hasWorkspaceRole(principal, 'owner', 'admin', 'editor');
}

export function canReviewWorkspace(principal: Principal): boolean {
  return hasWorkspaceRole(principal, 'owner', 'admin', 'editor', 'reviewer');
}
