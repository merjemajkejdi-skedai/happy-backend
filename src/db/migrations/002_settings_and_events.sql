-- Split configurable behavior out of venues into a dedicated
-- restaurant_settings table (every configurable feature lives here — no
-- per-venue env flags, no business rules hardcoded elsewhere), and add
-- order_events as an append-only audit log of every order state change.

CREATE TABLE restaurant_settings (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id                   UUID NOT NULL UNIQUE REFERENCES venues(id) ON DELETE CASCADE,

  currency                   VARCHAR(10) NOT NULL DEFAULT 'EUR',
  timezone                   VARCHAR(100) NOT NULL DEFAULT 'Europe/Tirane',

  counter_service_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  send_by_course             BOOLEAN NOT NULL DEFAULT FALSE,
  kitchen_display_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  bar_display_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  default_item_destination   VARCHAR(20) NOT NULL DEFAULT 'kitchen'
                                CHECK (default_item_destination IN ('kitchen', 'bar', 'printer')),
  waiter_login_method        VARCHAR(20) NOT NULL DEFAULT 'both'
                                CHECK (waiter_login_method IN ('pin', 'email', 'both')),

  -- Optional bolt-ons, off by default. Routes/serializers omit the
  -- corresponding response fields entirely while these are false.
  whatsapp_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  ai_enabled                 BOOLEAN NOT NULL DEFAULT FALSE,
  pms_enabled                BOOLEAN NOT NULL DEFAULT FALSE,

  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill a settings row for any venue created before this migration,
-- carrying over its current column values.
INSERT INTO restaurant_settings (
  venue_id, currency, timezone, counter_service_enabled, send_by_course,
  kitchen_display_enabled, bar_display_enabled, default_item_destination, waiter_login_method
)
SELECT id, currency, timezone, counter_service_enabled, send_by_course,
       kitchen_display_enabled, bar_display_enabled, default_item_destination, waiter_login_method
FROM venues;

ALTER TABLE venues
  DROP COLUMN currency,
  DROP COLUMN timezone,
  DROP COLUMN counter_service_enabled,
  DROP COLUMN send_by_course,
  DROP COLUMN kitchen_display_enabled,
  DROP COLUMN bar_display_enabled,
  DROP COLUMN default_item_destination,
  DROP COLUMN waiter_login_method;

CREATE INDEX idx_restaurant_settings_venue ON restaurant_settings(venue_id);

CREATE TABLE order_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  venue_id    UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  event_type  VARCHAR(50) NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  created_by  UUID REFERENCES staff(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- Append-only: no updated_at, no UPDATE/DELETE from application code.
);

CREATE INDEX idx_order_events_order ON order_events(order_id, created_at);
CREATE INDEX idx_order_events_venue ON order_events(venue_id, created_at);
