-- Hall Monitor admin control plane (HM-33). Content-free by design: no column holds learner
-- content. Every tenant-scoped query filters on `tenant` in its WHERE clause.

-- Role grants. The global `admin` role is stored with tenant '*'.
CREATE TABLE roles (
  email TEXT NOT NULL,
  tenant TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'policy-editor', 'labeler', 'adjudicator', 'publisher', 'admin')),
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (email, tenant, role)
);
CREATE INDEX roles_tenant ON roles (tenant);

-- Policy profile revisions: a tenant's overlay on one built-in floor, through its review states.
CREATE TABLE profile_revisions (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  overlay_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'proposed', 'approved', 'published')),
  student_facing INTEGER NOT NULL DEFAULT 0,
  enforces_family INTEGER NOT NULL DEFAULT 0,
  waiver_noted INTEGER NOT NULL DEFAULT 0,
  author TEXT NOT NULL,
  approver TEXT,
  violations_json TEXT NOT NULL DEFAULT '[]',
  diff_report_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant, profile_id, revision)
);
CREATE INDEX profile_revisions_tenant ON profile_revisions (tenant, profile_id, created_at);

-- Who did what to which id. Never content.
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  tenant TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL
);
CREATE INDEX audit_log_at ON audit_log (at);
CREATE INDEX audit_log_tenant ON audit_log (tenant, at);
