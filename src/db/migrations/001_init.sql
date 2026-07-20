-- Happy Restaurant POS — initial schema
-- Fresh, standalone database. No connection to any other system.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE venues (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                      VARCHAR(50) NOT NULL UNIQUE, -- login lookup key, e.g. "trattoria"
  name                      VARCHAR(255) NOT NULL,
  venue_type                VARCHAR(20) NOT NULL
                              CHECK (venue_type IN ('happy_restaurant', 'happy_bar', 'happy_hybrid')),
  currency                  VARCHAR(10) NOT NULL DEFAULT 'EUR',
  timezone                  VARCHAR(100) NOT NULL DEFAULT 'Europe/Tirane',

  counter_service_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  send_by_course            BOOLEAN NOT NULL DEFAULT FALSE,
  kitchen_display_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  bar_display_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  default_item_destination  VARCHAR(20) NOT NULL DEFAULT 'kitchen'
                              CHECK (default_item_destination IN ('kitchen', 'bar', 'printer')),
  waiter_login_method       VARCHAR(20) NOT NULL DEFAULT 'both'
                              CHECK (waiter_login_method IN ('pin', 'email', 'both')),

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE staff (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id    UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  email       VARCHAR(255),
  pin_hash    VARCHAR(255), -- bcrypt hash — never store a plain PIN
  role        VARCHAR(20) NOT NULL
                CHECK (role IN ('waiter', 'manager', 'kitchen', 'bar', 'admin')),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (venue_id, email)
);

CREATE TABLE tables (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id          UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  number            INTEGER,
  name              VARCHAR(100),
  section           VARCHAR(100),
  capacity          INTEGER NOT NULL DEFAULT 4,
  status            VARCHAR(20) NOT NULL DEFAULT 'available'
                      CHECK (status IN ('available', 'occupied', 'bill_requested', 'reserved', 'closed')),
  current_order_id  UUID,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE menu_categories (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id         UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name             VARCHAR(255) NOT NULL,
  description      TEXT,
  destination      VARCHAR(20) NOT NULL DEFAULT 'kitchen'
                     CHECK (destination IN ('kitchen', 'bar', 'printer')),
  sort_order       INTEGER NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE menu_items (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id               UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  category_id            UUID NOT NULL REFERENCES menu_categories(id) ON DELETE CASCADE,
  name                   VARCHAR(255) NOT NULL,
  description            TEXT,
  price                  DECIMAL(10,2) NOT NULL CHECK (price >= 0),
  destination_override   VARCHAR(20) CHECK (destination_override IN ('kitchen', 'bar', 'printer')),
  course                 VARCHAR(20),
  is_available           BOOLEAN NOT NULL DEFAULT TRUE, -- toggled off to "86" an item mid-service
  sort_order             INTEGER NOT NULL DEFAULT 0,
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE orders (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id       UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  table_id       UUID REFERENCES tables(id), -- NULL for counter-service orders
  waiter_id      UUID NOT NULL REFERENCES staff(id),
  order_number   INTEGER NOT NULL,
  ticket_number  INTEGER, -- set only for counter-service orders
  status         VARCHAR(20) NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'bill_requested', 'paid', 'voided')),
  subtotal       DECIMAL(10,2) NOT NULL DEFAULT 0,
  discount       DECIMAL(10,2) NOT NULL DEFAULT 0,
  total          DECIMAL(10,2) NOT NULL DEFAULT 0,
  notes          TEXT,
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Daily order/ticket number sequence per venue.
CREATE TABLE order_sequences (
  venue_id             UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  date                 DATE NOT NULL,
  last_order_number    INTEGER NOT NULL DEFAULT 0,
  last_ticket_number   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (venue_id, date)
);

CREATE TABLE order_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  venue_id      UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  menu_item_id  UUID NOT NULL REFERENCES menu_items(id),
  name          VARCHAR(255) NOT NULL,     -- snapshot at order time
  unit_price    DECIMAL(10,2) NOT NULL,    -- snapshot at order time
  total_price   DECIMAL(10,2) NOT NULL,    -- unit_price * quantity
  quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  course        VARCHAR(20),
  destination   VARCHAR(20) NOT NULL DEFAULT 'kitchen'
                  CHECK (destination IN ('kitchen', 'bar', 'printer')), -- resolved at order time
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'in_progress', 'ready', 'delivered', 'voided')),
  sent_at       TIMESTAMPTZ,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE kitchen_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id          UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  order_id          UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  table_id          UUID REFERENCES tables(id),
  table_display     VARCHAR(50), -- e.g. "Table 5" or "Counter #12"
  event_type        VARCHAR(30) NOT NULL DEFAULT 'new_items',
  destination       VARCHAR(20) NOT NULL CHECK (destination IN ('kitchen', 'bar')),
  course            VARCHAR(20),
  items             JSONB NOT NULL DEFAULT '[]', -- snapshot: [{ name, quantity, notes, course }]
  is_acknowledged   BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_at   TIMESTAMPTZ,
  acknowledged_by   UUID REFERENCES staff(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_staff_venue           ON staff(venue_id, is_active);
CREATE INDEX idx_tables_venue          ON tables(venue_id, is_active);
CREATE INDEX idx_menu_categories_venue ON menu_categories(venue_id, is_active);
CREATE INDEX idx_menu_items_venue      ON menu_items(venue_id, is_active);
CREATE INDEX idx_menu_items_category   ON menu_items(category_id);
CREATE INDEX idx_orders_venue          ON orders(venue_id, status);
CREATE INDEX idx_orders_table          ON orders(table_id);
CREATE INDEX idx_orders_waiter         ON orders(waiter_id);
CREATE INDEX idx_order_items_order     ON order_items(order_id);
CREATE INDEX idx_order_items_venue     ON order_items(venue_id);
CREATE INDEX idx_kitchen_events_feed   ON kitchen_events(venue_id, destination, is_acknowledged);
