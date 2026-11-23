-- Hall Monitor admin control plane, writes (HM-34): config releases, tenant modes and label review.

-- Published config releases. document_json is the exact canonical body stored in R2.
CREATE TABLE releases (
  release_id TEXT PRIMARY KEY,
  digest TEXT NOT NULL UNIQUE,
  author TEXT NOT NULL,
  approver TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  document_json TEXT NOT NULL
);

-- A tenant's enforcement mode as the next release will carry it. No rows: releases omit
-- tenantModes and the Worker keeps HM_TENANT_MODES.
CREATE TABLE tenant_modes (
  tenant TEXT PRIMARY KEY,
  setting_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Label sets hold synthetic or licensed calibration studies only (the study schema enforces it).
-- The blinding key never leaves the Worker in a response.
CREATE TABLE label_sets (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  family TEXT NOT NULL,
  study_json TEXT NOT NULL,
  study_digest TEXT NOT NULL,
  packet_json TEXT NOT NULL,
  blind_key_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX label_sets_tenant ON label_sets (tenant, created_at);

CREATE TABLE label_items (
  set_id TEXT NOT NULL,
  blind_id TEXT NOT NULL,
  tenant TEXT NOT NULL,
  PRIMARY KEY (set_id, blind_id)
);

CREATE TABLE labels (
  set_id TEXT NOT NULL,
  blind_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  label TEXT NOT NULL CHECK (label IN ('positive', 'negative', 'ambiguous')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (set_id, blind_id, decision_id, reviewer)
);

CREATE TABLE adjudications (
  set_id TEXT NOT NULL,
  blind_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  adjudicator TEXT NOT NULL,
  label TEXT NOT NULL CHECK (label IN ('positive', 'negative', 'ambiguous')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (set_id, blind_id, decision_id)
);

-- Imported model predictions for a set (run metadata and scores), one document per set.
CREATE TABLE predictions (
  set_id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE TABLE calibration_reports (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL,
  tenant TEXT NOT NULL,
  report_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX calibration_reports_set ON calibration_reports (tenant, set_id, created_at);
