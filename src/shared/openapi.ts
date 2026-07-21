import { ERROR_CODES } from './errorCodes';

// Hand-authored OpenAPI 3.1 document — the contract a POS client is
// generated from. Served live at GET /api/v1/openapi.json and snapshotted
// to docs/openapi.json. Kept in sync with the actual routes by hand (no
// Zod-derivation in this codebase); docs/API.md is the companion
// human-readable route table.

const money = { type: 'number', description: 'Decimal on the wire — never a string, never client-trusted for totals.' };

const errorEnvelope = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { $ref: '#/components/schemas/ErrorCode' },
        message: { type: 'string' },
        details: {},
      },
    },
  },
};

function envelope(dataSchema: object, metaSchema: object = { type: 'object' }) {
  return {
    type: 'object',
    required: ['data', 'meta'],
    properties: { data: dataSchema, meta: metaSchema },
  };
}

const paginationMeta = {
  type: 'object',
  properties: {
    page: { type: 'integer' },
    per_page: { type: 'integer' },
    total: { type: 'integer' },
    total_pages: { type: 'integer' },
  },
};

function response(description: string, schema?: object) {
  return {
    description,
    content: { 'application/json': { schema: schema ?? errorEnvelope } },
  };
}

const errorResponses = {
  '400': response('Validation error', errorEnvelope),
  '401': response('Missing/invalid/expired token', errorEnvelope),
  '403': response('Forbidden — role lacks the required permission, or a business-rule gate', errorEnvelope),
  '404': response('Not found', errorEnvelope),
  '409': response('Conflict — state/uniqueness violation', errorEnvelope),
  '422': response('Business-rule validation failure', errorEnvelope),
};

// ── Reusable resource schemas ────────────────────────────────────────────────

const schemas: Record<string, object> = {
  ErrorCode: { type: 'string', enum: [...ERROR_CODES] },

  Venue: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      slug: { type: 'string' },
      venueType: { type: 'string', enum: ['happy_restaurant', 'happy_bar', 'happy_hybrid'] },
      timezone: { type: 'string' },
      currency: { type: 'string' },
      locale: { type: 'string' },
      address: { type: ['string', 'null'] },
      phone: { type: ['string', 'null'] },
      isActive: { type: 'boolean' },
      pmsProvider: { type: ['string', 'null'], description: 'Omitted entirely unless restaurant_settings.pms_enabled is true.' },
      pmsPropertyId: { type: ['string', 'null'] },
      pmsConfig: { description: 'Omitted entirely unless pms_enabled is true.' },
    },
  },

  RestaurantSettings: {
    type: 'object',
    description: 'Every configurable behavior for a venue. whatsapp_config/ai_config/pms_room_charge_enabled are omitted entirely (not null) while their gating flag is false.',
    properties: {
      loginMethod: { type: 'string', enum: ['pin', 'email', 'both'] },
      pinLength: { type: 'integer' },
      sessionTimeoutMinutes: { type: 'integer' },
      requirePinOnReopen: { type: 'boolean' },
      tableNamingMode: { type: 'string', enum: ['number', 'name', 'both'] },
      tablesEnabled: { type: 'boolean' },
      counterServiceEnabled: { type: 'boolean' },
      ticketNumberPrefix: { type: 'string' },
      ticketNumberReset: { type: 'string', enum: ['daily', 'never'] },
      requireTableForOrder: { type: 'boolean' },
      allowTableTransfer: { type: 'boolean' },
      allowOrderMerge: { type: 'boolean' },
      coursesEnabled: { type: 'boolean' },
      defaultCourseCount: { type: 'integer' },
      modifiersEnabled: { type: 'boolean' },
      allowFreeTextNotes: { type: 'boolean' },
      kitchenDisplayEnabled: { type: 'boolean' },
      barDisplayEnabled: { type: 'boolean' },
      displayAutoRefreshSeconds: { type: 'integer' },
      displayShowElapsedTime: { type: 'boolean' },
      displayWarnAfterMinutes: { type: 'integer' },
      allowItemVoidAfterSend: { type: 'boolean' },
      requireReasonOnVoid: { type: 'boolean' },
      autoSendOnAdd: { type: 'boolean' },
      whatsappEnabled: { type: 'boolean' },
      whatsappConfig: { description: 'Present only when whatsapp_enabled is true.' },
      aiEnabled: { type: 'boolean' },
      aiConfig: { description: 'Present only when ai_enabled is true.' },
      pmsEnabled: { type: 'boolean' },
      pmsRoomChargeEnabled: { type: 'boolean', description: 'Present only when pms_enabled is true.' },
      taxRatePercent: money,
      serviceChargePercent: money,
    },
  },

  User: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      fullName: { type: 'string' },
      email: { type: ['string', 'null'] },
      role: { type: 'string', enum: ['waiter', 'kitchen', 'admin', 'manager', 'bar'] },
      isActive: { type: 'boolean' },
      lastLoginAt: { type: ['string', 'null'], format: 'date-time' },
    },
  },

  Area: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      sortOrder: { type: 'integer' },
      isActive: { type: 'boolean' },
      defaultDestination: { type: ['string', 'null'], enum: ['kitchen', 'bar', 'none', null] },
    },
  },

  Table: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      areaId: { type: ['string', 'null'], format: 'uuid' },
      tableNumber: { type: ['integer', 'null'] },
      tableName: { type: ['string', 'null'] },
      seats: { type: 'integer' },
      status: { type: 'string', enum: ['free', 'occupied', 'reserved', 'dirty'] },
      isActive: { type: 'boolean' },
      displayLabel: { type: 'string', description: 'Derived from table_naming_mode — the client renders this directly.' },
      activeOrder: {
        type: ['object', 'null'],
        properties: {
          orderId: { type: 'string', format: 'uuid' },
          orderNumber: { type: 'integer' },
          status: { type: 'string' },
          itemCount: { type: 'integer' },
          grandTotal: money,
          openedAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },

  MenuCategory: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      description: { type: ['string', 'null'] },
      defaultDestination: { type: 'string', enum: ['kitchen', 'bar', 'none'] },
      defaultCourseNumber: { type: ['integer', 'null'] },
      sortOrder: { type: 'integer' },
      isActive: { type: 'boolean' },
      colorHex: { type: ['string', 'null'] },
    },
  },

  MenuItem: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      categoryId: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      description: { type: ['string', 'null'] },
      price: money,
      destination: { type: 'string', enum: ['kitchen', 'bar', 'none'] },
      courseNumber: { type: ['integer', 'null'] },
      sku: { type: ['string', 'null'] },
      isActive: { type: 'boolean' },
      isAvailable: { type: 'boolean', description: 'The "86" toggle.' },
      sortOrder: { type: 'integer' },
      imageUrl: { type: ['string', 'null'] },
      prepMinutes: { type: ['integer', 'null'] },
      taxRatePercent: { ...money, description: 'Overrides the venue default tax rate when set.' },
    },
  },

  ModifierOption: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      groupId: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      priceDelta: money,
      isActive: { type: 'boolean' },
      sortOrder: { type: 'integer' },
    },
  },

  ModifierGroup: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      type: { type: 'string', enum: ['single', 'multiple'] },
      isRequired: { type: 'boolean' },
      minSelect: { type: 'integer' },
      maxSelect: { type: ['integer', 'null'] },
      sortOrder: { type: 'integer' },
      options: { type: 'array', items: { $ref: '#/components/schemas/ModifierOption' } },
    },
  },

  MenuTreeCategory: {
    type: 'object',
    description: 'GET /menu — one call, the whole active menu, excluding soft-deleted/inactive.',
    allOf: [
      { $ref: '#/components/schemas/MenuCategory' },
      {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              allOf: [
                { $ref: '#/components/schemas/MenuItem' },
                { type: 'object', properties: { modifierGroups: { type: 'array', items: { $ref: '#/components/schemas/ModifierGroup' } } } },
              ],
            },
          },
        },
      },
    ],
  },

  OrderItemModifier: {
    type: 'object',
    description: 'Snapshotted at insert — never re-derived from modifier_options.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      groupNameSnapshot: { type: 'string' },
      optionNameSnapshot: { type: 'string' },
      priceDeltaSnapshot: money,
    },
  },

  OrderItem: {
    type: 'object',
    description: 'item_name_snapshot/category_name_snapshot/unit_price_snapshot/destination_snapshot/tax_rate_snapshot are copied from the menu at insert time and never change when the menu does.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      orderId: { type: 'string', format: 'uuid' },
      menuItemId: { type: ['string', 'null'], format: 'uuid' },
      itemNameSnapshot: { type: 'string' },
      categoryNameSnapshot: { type: 'string' },
      unitPriceSnapshot: money,
      destinationSnapshot: { type: 'string', enum: ['kitchen', 'bar', 'none'] },
      courseNumberSnapshot: { type: ['integer', 'null'] },
      taxRateSnapshot: money,
      quantity: { type: 'integer' },
      modifiersTotal: money,
      lineTotal: money,
      status: { type: 'string', enum: ['pending', 'sent', 'preparing', 'ready', 'served', 'cancelled'] },
      notes: { type: ['string', 'null'] },
      sentAt: { type: ['string', 'null'], format: 'date-time' },
      preparingAt: { type: ['string', 'null'], format: 'date-time' },
      readyAt: { type: ['string', 'null'], format: 'date-time' },
      servedAt: { type: ['string', 'null'], format: 'date-time' },
      cancelledAt: { type: ['string', 'null'], format: 'date-time' },
      cancelReason: { type: ['string', 'null'] },
      modifiers: { type: 'array', items: { $ref: '#/components/schemas/OrderItemModifier' } },
    },
  },

  Order: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      orderNumber: { type: 'integer' },
      serviceMode: { type: 'string', enum: ['table', 'counter'] },
      tableId: { type: ['string', 'null'], format: 'uuid' },
      ticketNumber: { type: ['string', 'null'] },
      guestCount: { type: ['integer', 'null'] },
      customerName: { type: ['string', 'null'] },
      status: { type: 'string', enum: ['draft', 'open', 'sent', 'partially_served', 'served', 'closed', 'cancelled'] },
      openedByUserId: { type: 'string', format: 'uuid' },
      openedAt: { type: 'string', format: 'date-time' },
      firstSentAt: { type: ['string', 'null'], format: 'date-time' },
      closedAt: { type: ['string', 'null'], format: 'date-time' },
      cancelledAt: { type: ['string', 'null'], format: 'date-time' },
      cancelReason: { type: ['string', 'null'] },
      subtotal: money,
      taxTotal: money,
      serviceChargeTotal: money,
      discountTotal: { ...money, description: 'Always 0 in Phase 1 — no discount feature exists yet.' },
      grandTotal: money,
      notes: { type: ['string', 'null'] },
      pmsFolioId: { type: ['string', 'null'], description: 'Omitted entirely unless pms_enabled is true (schema-only in Phase 1 — always null even when present).' },
      pmsRoomNumber: { type: ['string', 'null'] },
      pmsPostedAt: { type: ['string', 'null'], format: 'date-time' },
      tableDisplayLabel: { type: ['string', 'null'], description: 'null for counter orders. Only present on GET /orders/:id.' },
      openedByName: { type: 'string', description: 'Only present on GET /orders/:id.' },
      items: { type: 'array', items: { $ref: '#/components/schemas/OrderItem' } },
    },
  },

  OrderEvent: {
    type: 'object',
    description: 'Append-only audit log row.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      orderId: { type: 'string', format: 'uuid' },
      orderItemId: { type: ['string', 'null'], format: 'uuid' },
      eventType: { type: 'string' },
      actorUserId: { type: ['string', 'null'], format: 'uuid' },
      actorName: { type: ['string', 'null'] },
      payload: { type: 'object' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },

  DisplayTicket: {
    type: 'object',
    description: 'Locked response shape (Prompt 9) — snake_case, sourced entirely from order_item/order_item_modifier snapshot columns, never a join to menu_items.',
    properties: {
      order_id: { type: 'string', format: 'uuid' },
      order_number: { type: 'integer' },
      ticket_number: { type: ['string', 'null'] },
      service_mode: { type: 'string', enum: ['table', 'counter'] },
      table_display_label: { type: ['string', 'null'] },
      guest_count: { type: ['integer', 'null'] },
      customer_name: { type: ['string', 'null'] },
      opened_at: { type: 'string', format: 'date-time' },
      first_sent_at: { type: ['string', 'null'], format: 'date-time' },
      waiter_name: { type: 'string' },
      elapsed_seconds: { type: 'integer' },
      is_warning: { type: 'boolean' },
      courses: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            course_number: { type: ['integer', 'null'] },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  item_name: { type: 'string' },
                  quantity: { type: 'integer' },
                  notes: { type: ['string', 'null'] },
                  status: { type: 'string' },
                  sent_at: { type: ['string', 'null'], format: 'date-time' },
                  preparing_at: { type: ['string', 'null'], format: 'date-time' },
                  ready_at: { type: ['string', 'null'], format: 'date-time' },
                  elapsed_seconds: { type: 'integer' },
                  modifiers: {
                    type: 'array',
                    items: { type: 'object', properties: { group_name: { type: 'string' }, option_name: { type: 'string' } } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },

  DisplayMeta: {
    type: 'object',
    properties: {
      generated_at: { type: 'string', format: 'date-time' },
      refresh_seconds: { type: 'integer' },
      ticket_count: { type: 'integer' },
      item_count: { type: 'integer' },
    },
  },
};

// ── Path helpers ─────────────────────────────────────────────────────────────

const bearerAuth = [{ bearerAuth: [] }];

function op(summary: string, tags: string[], opts: Partial<{
  security: object[];
  parameters: object[];
  requestBody: object;
  responses: Record<string, object>;
}> = {}) {
  return {
    summary,
    tags,
    security: opts.security ?? bearerAuth,
    ...(opts.parameters ? { parameters: opts.parameters } : {}),
    ...(opts.requestBody ? { requestBody: { required: true, content: { 'application/json': { schema: opts.requestBody } } } } : {}),
    responses: { '200': response('OK'), ...errorResponses, ...opts.responses },
  };
}

function pathParam(name: string, description: string) {
  return { name, in: 'path', required: true, schema: { type: 'string' }, description };
}

function queryParam(name: string, schema: object = { type: 'string' }) {
  return { name, in: 'query', required: false, schema };
}

const idempotencyKeyHeader = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  schema: { type: 'string' },
  description: 'Scoped per (venue, user, route). Replay within 24h returns the original response verbatim; a concurrent duplicate gets 409 IDEMPOTENCY_IN_PROGRESS.',
};

const paginationParams = [queryParam('page', { type: 'integer' }), queryParam('per_page', { type: 'integer' })];

const orderSchema = { $ref: '#/components/schemas/Order' };
const orderItemSchema = { $ref: '#/components/schemas/OrderItem' };

const paths: Record<string, Record<string, object>> = {
  '/health': {
    get: op('Liveness check', ['System'], { security: [], responses: { '200': response('OK') } }),
  },

  // ── Auth ─────────────────────────────────────────────────────────────────
  '/auth/login/pin': {
    post: op('Log in with venue_slug + PIN', ['Auth'], {
      security: [],
      requestBody: { type: 'object', required: ['venue_slug', 'pin'], properties: { venue_slug: { type: 'string' }, pin: { type: 'string' } } },
      responses: { '429': response('Rate limited — 10 attempts/min per venue_slug+IP', errorEnvelope) },
    }),
  },
  '/auth/login/email': {
    post: op('Log in with venue_slug + email + password', ['Auth'], {
      security: [],
      requestBody: {
        type: 'object',
        required: ['venue_slug', 'email', 'password'],
        properties: { venue_slug: { type: 'string' }, email: { type: 'string' }, password: { type: 'string' } },
      },
      responses: { '429': response('Rate limited — 10 attempts/min per venue_slug+IP', errorEnvelope) },
    }),
  },
  '/auth/refresh': {
    post: op('Rotate an access/refresh token pair', ['Auth'], {
      security: [],
      requestBody: { type: 'object', required: ['refresh_token'], properties: { refresh_token: { type: 'string' } } },
    }),
  },
  '/auth/logout': {
    post: op('Revoke a refresh token', ['Auth'], {
      requestBody: { type: 'object', required: ['refresh_token'], properties: { refresh_token: { type: 'string' } } },
    }),
  },
  '/auth/me': {
    get: op('Current user + venue + settings', ['Auth']),
  },
  '/auth/venue-config': {
    get: op('Public venue lookup by slug — login_method, locale, currency only', ['Auth'], {
      security: [],
      parameters: [queryParam('slug')],
    }),
  },

  // ── Venue ────────────────────────────────────────────────────────────────
  '/venue': {
    get: op('Get this venue', ['Venue']),
    patch: op('Update venue identity/contact fields (requires venue.write)', ['Venue'], {
      requestBody: { type: 'object', description: 'name, timezone, currency, locale, address, phone, is_active — venue_type is not editable.' },
    }),
  },

  // ── Settings ─────────────────────────────────────────────────────────────
  '/settings': {
    get: op('Get restaurant_settings', ['Settings']),
    patch: op('Update settings (requires settings.write) — validated against the merged current+patch state', ['Settings'], {
      requestBody: { type: 'object', description: 'Any subset of the editable settings fields.' },
    }),
  },

  // ── Users ────────────────────────────────────────────────────────────────
  '/users': {
    get: op('List staff (requires user.manage)', ['Users'], {
      parameters: [...paginationParams, queryParam('role'), queryParam('is_active', { type: 'boolean' })],
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/User' } }, paginationMeta)) },
    }),
    post: op('Create a staff account (requires user.manage)', ['Users'], {
      requestBody: {
        type: 'object',
        required: ['full_name', 'role'],
        properties: {
          full_name: { type: 'string' },
          role: { type: 'string', enum: ['waiter', 'kitchen', 'admin'] },
          email: { type: 'string' },
          password: { type: 'string' },
          pin: { type: 'string' },
        },
      },
    }),
  },
  '/users/{id}': {
    get: op('Get a staff account (requires user.manage)', ['Users'], { parameters: [pathParam('id', 'User id')] }),
    patch: op('Update a staff account (requires user.manage)', ['Users'], { parameters: [pathParam('id', 'User id')] }),
    delete: op('Soft-delete a staff account (requires user.manage)', ['Users'], { parameters: [pathParam('id', 'User id')] }),
  },
  '/users/{id}/reset-pin': {
    post: op('Reset a user\'s PIN (requires user.manage)', ['Users'], {
      parameters: [pathParam('id', 'User id')],
      requestBody: { type: 'object', required: ['pin'], properties: { pin: { type: 'string' } } },
    }),
  },
  '/users/{id}/reset-password': {
    post: op('Reset a user\'s password (requires user.manage; user must have an email on file)', ['Users'], {
      parameters: [pathParam('id', 'User id')],
      requestBody: { type: 'object', required: ['password'], properties: { password: { type: 'string' } } },
    }),
  },

  // ── Areas ────────────────────────────────────────────────────────────────
  '/areas': {
    get: op('List areas', ['Areas'], {
      parameters: paginationParams,
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/Area' } }, paginationMeta)) },
    }),
    post: op('Create an area (requires table.write)', ['Areas'], {
      requestBody: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, default_destination: { type: 'string' } } },
    }),
  },
  '/areas/{id}': {
    patch: op('Update an area (requires table.write)', ['Areas'], { parameters: [pathParam('id', 'Area id')] }),
    delete: op('Soft-delete an area (requires table.write) — pass ?reassign_to= if it has active tables', ['Areas'], {
      parameters: [pathParam('id', 'Area id'), queryParam('reassign_to')],
    }),
  },

  // ── Tables ───────────────────────────────────────────────────────────────
  '/tables': {
    get: op('List tables', ['Tables'], {
      parameters: [...paginationParams, queryParam('area_id'), queryParam('status')],
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/Table' } }, paginationMeta)) },
    }),
    post: op('Create a table (requires table.write)', ['Tables'], {
      requestBody: { type: 'object', properties: { area_id: { type: 'string' }, table_number: { type: 'integer' }, table_name: { type: 'string' }, seats: { type: 'integer' } } },
    }),
  },
  '/tables/bulk': {
    post: op('Bulk-create a numeric range of tables (requires table.write, max 500)', ['Tables'], {
      requestBody: { type: 'object', required: ['area_id', 'from', 'to'], properties: { area_id: { type: 'string' }, from: { type: 'integer' }, to: { type: 'integer' } } },
    }),
  },
  '/tables/{id}': {
    get: op('Get a table', ['Tables'], { parameters: [pathParam('id', 'Table id')] }),
    patch: op('Update a table (requires table.write)', ['Tables'], { parameters: [pathParam('id', 'Table id')] }),
    delete: op('Soft-delete a table (requires table.write) — blocked if it has an active order', ['Tables'], { parameters: [pathParam('id', 'Table id')] }),
  },
  '/tables/{id}/status': {
    patch: op('Set a table\'s status directly (requires table.status)', ['Tables'], {
      parameters: [pathParam('id', 'Table id')],
      requestBody: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['free', 'occupied', 'reserved', 'dirty'] } } },
    }),
  },

  // ── Menu ─────────────────────────────────────────────────────────────────
  '/menu': {
    get: op('Full active menu tree in one call — the endpoint the POS caches at login. Returns an ETag/menu_version.', ['Menu'], {
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/MenuTreeCategory' } }, { type: 'object', properties: { menu_version: { type: 'string' } } })) },
    }),
  },
  '/menu/categories': {
    get: op('List menu categories', ['Menu'], {
      parameters: [...paginationParams, queryParam('is_active', { type: 'boolean' })],
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/MenuCategory' } }, paginationMeta)) },
    }),
    post: op('Create a category (requires menu.write) — destination/course validated against venue_type/courses_enabled', ['Menu'], {
      requestBody: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, default_destination: { type: 'string' }, default_course_number: { type: 'integer' } } },
    }),
  },
  '/menu/categories/{id}': {
    patch: op('Update a category (requires menu.write)', ['Menu'], { parameters: [pathParam('id', 'Category id')] }),
    delete: op('Soft-delete a category (requires menu.write) — 409 if it has active items', ['Menu'], { parameters: [pathParam('id', 'Category id')] }),
  },
  '/menu/items': {
    get: op('List menu items', ['Menu'], {
      parameters: [...paginationParams, queryParam('category_id'), queryParam('is_available', { type: 'boolean' }), queryParam('search')],
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/MenuItem' } }, paginationMeta)) },
    }),
    post: op('Create an item (requires menu.write) — destination/course inherit from the category unless overridden', ['Menu'], {
      requestBody: { type: 'object', required: ['category_id', 'name', 'price'], properties: { category_id: { type: 'string' }, name: { type: 'string' }, price: { type: 'number' } } },
    }),
  },
  '/menu/items/{id}': {
    get: op('Get a menu item', ['Menu'], { parameters: [pathParam('id', 'Item id')] }),
    patch: op('Update an item (requires menu.write)', ['Menu'], { parameters: [pathParam('id', 'Item id')] }),
    delete: op('Soft-delete an item (requires menu.write)', ['Menu'], { parameters: [pathParam('id', 'Item id')] }),
  },
  '/menu/items/{id}/availability': {
    patch: op('The "86" toggle (requires menu.availability — waiter, kitchen, and admin)', ['Menu'], {
      parameters: [pathParam('id', 'Item id')],
      requestBody: { type: 'object', required: ['is_available'], properties: { is_available: { type: 'boolean' } } },
    }),
  },
  '/menu/items/{id}/modifier-groups': {
    post: op('Replace the full set of modifier groups attached to this item (requires menu.write)', ['Menu'], {
      parameters: [pathParam('id', 'Item id')],
      requestBody: { type: 'object', required: ['group_ids'], properties: { group_ids: { type: 'array', items: { type: 'string' } } } },
    }),
  },
  '/menu/modifier-groups': {
    get: op('List modifier groups with their options', ['Menu'], {
      parameters: paginationParams,
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/ModifierGroup' } }, paginationMeta)) },
    }),
    post: op('Create a modifier group (requires menu.write)', ['Menu'], {
      requestBody: { type: 'object', required: ['name', 'type'], properties: { name: { type: 'string' }, type: { type: 'string', enum: ['single', 'multiple'] } } },
    }),
  },
  '/menu/modifier-groups/{id}': {
    patch: op('Update a modifier group (requires menu.write)', ['Menu'], { parameters: [pathParam('id', 'Group id')] }),
    delete: op('Soft-delete a modifier group (requires menu.write)', ['Menu'], { parameters: [pathParam('id', 'Group id')] }),
  },
  '/menu/modifier-groups/{id}/options': {
    post: op('Add an option to a group (requires menu.write)', ['Menu'], {
      parameters: [pathParam('id', 'Group id')],
      requestBody: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, price_delta: { type: 'number' } } },
    }),
  },
  '/menu/modifier-options/{id}': {
    patch: op('Update a modifier option (requires menu.write)', ['Menu'], { parameters: [pathParam('id', 'Option id')] }),
    delete: op('Soft-delete a modifier option (requires menu.write)', ['Menu'], { parameters: [pathParam('id', 'Option id')] }),
  },

  // ── Orders ───────────────────────────────────────────────────────────────
  '/orders': {
    get: op('List orders', ['Orders'], {
      parameters: [...paginationParams, queryParam('status'), queryParam('table_id'), queryParam('service_mode'), queryParam('mine', { type: 'boolean' }), queryParam('date')],
      responses: { '200': response('OK', envelope({ type: 'array', items: orderSchema }, paginationMeta)) },
    }),
    post: op('Create an order (requires order.create) — table or counter mode', ['Orders'], {
      parameters: [idempotencyKeyHeader],
      requestBody: {
        type: 'object',
        required: ['service_mode'],
        properties: {
          service_mode: { type: 'string', enum: ['table', 'counter'] },
          table_id: { type: 'string' },
          guest_count: { type: 'integer' },
          customer_name: { type: 'string' },
        },
      },
      responses: { '200': response('OK', envelope(orderSchema)), '409': response('Table already has an active order, or a concurrent idempotent duplicate', errorEnvelope) },
    }),
  },
  '/orders/{id}': {
    get: op('Full order — items with modifiers, table display_label, totals, opened_by name', ['Orders'], {
      parameters: [pathParam('id', 'Order id')],
      responses: { '200': response('OK', envelope(orderSchema)) },
    }),
    patch: op('Update guest_count/customer_name/notes only (requires order.create)', ['Orders'], { parameters: [pathParam('id', 'Order id')] }),
  },
  '/orders/{id}/items': {
    post: op('Add an item to an order (requires order.create) — snapshots the menu at insert time', ['Orders'], {
      parameters: [pathParam('id', 'Order id'), idempotencyKeyHeader],
      requestBody: {
        type: 'object',
        required: ['menu_item_id'],
        properties: {
          menu_item_id: { type: 'string' },
          quantity: { type: 'integer' },
          modifier_option_ids: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' },
          course_number: { type: 'integer' },
        },
      },
      responses: { '200': response('OK', envelope(orderItemSchema)) },
    }),
  },
  '/orders/{id}/items/{itemId}': {
    patch: op('Update quantity/notes/modifiers — only while the item is pending (requires order.create)', ['Orders'], {
      parameters: [pathParam('id', 'Order id'), pathParam('itemId', 'Order item id')],
      responses: { '200': response('OK', envelope(orderItemSchema)) },
    }),
    delete: op('Void an item — any waiter while pending; admin-only (order.void_after_send) once sent', ['Orders'], {
      parameters: [pathParam('id', 'Order id'), pathParam('itemId', 'Order item id')],
      requestBody: { type: 'object', properties: { reason: { type: 'string' } } },
    }),
  },
  '/orders/{id}/items/{itemId}/serve': {
    patch: op('Mark one ready item served (requires order.serve)', ['Orders'], {
      parameters: [pathParam('id', 'Order id'), pathParam('itemId', 'Order item id')],
    }),
  },
  '/orders/{id}/send': {
    post: op('Send pending items to kitchen/bar (requires order.send) — by course, by item_ids, or all', ['Orders'], {
      parameters: [pathParam('id', 'Order id'), idempotencyKeyHeader],
      requestBody: { type: 'object', properties: { course_number: { type: 'integer' }, item_ids: { type: 'array', items: { type: 'string' } } } },
      responses: {
        '200': response('OK', envelope({
          type: 'object',
          properties: {
            kitchen: { type: 'object', properties: { count: { type: 'integer' }, items: { type: 'array', items: { type: 'object' } } } },
            bar: { type: 'object', properties: { count: { type: 'integer' }, items: { type: 'array', items: { type: 'object' } } } },
          },
        })),
      },
    }),
  },
  '/orders/{id}/transfer': {
    post: op('Move an order to a different table (requires order.transfer, and allow_table_transfer)', ['Orders'], {
      parameters: [pathParam('id', 'Order id')],
      requestBody: { type: 'object', required: ['table_id'], properties: { table_id: { type: 'string' } } },
      responses: { '200': response('OK', envelope(orderSchema)) },
    }),
  },
  '/orders/{id}/serve': {
    post: op('Bulk-serve ready items (requires order.serve) — defaults to all ready items', ['Orders'], {
      parameters: [pathParam('id', 'Order id')],
      requestBody: { type: 'object', properties: { item_ids: { type: 'array', items: { type: 'string' } } } },
    }),
  },
  '/orders/{id}/close': {
    post: op('Close an order (requires order.close) — blocked while any non-cancelled item is unserved; no payment handling in Phase 1', ['Orders'], {
      parameters: [pathParam('id', 'Order id')],
      responses: { '200': response('OK', envelope(orderSchema)) },
    }),
  },
  '/orders/{id}/cancel': {
    post: op('Cancel an order and all its items — a waiter may only before anything is sent; admin-only (order.cancel_sent) after', ['Orders'], {
      parameters: [pathParam('id', 'Order id')],
      requestBody: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } },
      responses: { '200': response('OK', envelope(orderSchema)) },
    }),
  },
  '/orders/{id}/events': {
    get: op('Paginated audit trail, newest first, actor names resolved (requires order.events.read — admin)', ['Orders'], {
      parameters: [pathParam('id', 'Order id'), ...paginationParams],
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/OrderEvent' } }, paginationMeta)) },
    }),
  },

  // ── Displays ─────────────────────────────────────────────────────────────
  '/displays/kitchen': {
    get: op('Kitchen display tickets (requires display.view) — 403 if kitchen_display_enabled is false', ['Displays'], {
      parameters: [queryParam('course_number', { type: 'integer' }), queryParam('include_ready', { type: 'boolean' })],
      responses: {
        '200': response('OK', envelope({ type: 'object', properties: { tickets: { type: 'array', items: { $ref: '#/components/schemas/DisplayTicket' } } } }, { $ref: '#/components/schemas/DisplayMeta' })),
      },
    }),
  },
  '/displays/bar': {
    get: op('Bar display tickets (requires display.view) — 403 if bar_display_enabled is false', ['Displays'], {
      parameters: [queryParam('course_number', { type: 'integer' }), queryParam('include_ready', { type: 'boolean' })],
      responses: {
        '200': response('OK', envelope({ type: 'object', properties: { tickets: { type: 'array', items: { $ref: '#/components/schemas/DisplayTicket' } } } }, { $ref: '#/components/schemas/DisplayMeta' })),
      },
    }),
  },
  '/displays/recall': {
    get: op('Items marked ready in the last 30 minutes, not yet served (requires display.bump)', ['Displays'], {
      responses: {
        '200': response('OK', envelope({ type: 'object', properties: { tickets: { type: 'array', items: { $ref: '#/components/schemas/DisplayTicket' } } } }, { $ref: '#/components/schemas/DisplayMeta' })),
      },
    }),
  },
  '/displays/items/{itemId}/status': {
    patch: op('Single valid-transition bump (requires display.bump) — sent->preparing, sent->ready, preparing->ready', ['Displays'], {
      parameters: [pathParam('itemId', 'Order item id')],
      requestBody: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['preparing', 'ready'] } } },
    }),
  },
  '/displays/bump': {
    post: op('Bulk transition to ready in one transaction (requires display.bump) — explicit item_ids is all-or-nothing, order_id auto-resolves eligible items', ['Displays'], {
      requestBody: { type: 'object', properties: { order_item_ids: { type: 'array', items: { type: 'string' } }, order_id: { type: 'string' }, status: { type: 'string', enum: ['ready'] } } },
    }),
  },
  '/displays/items/{itemId}/recall': {
    post: op('Un-bump a mistake: ready -> preparing, clears ready_at (requires display.bump)', ['Displays'], {
      parameters: [pathParam('itemId', 'Order item id')],
    }),
  },

  // ── OpenAPI ──────────────────────────────────────────────────────────────
  '/openapi.json': {
    get: op('This document', ['System'], { security: [], responses: { '200': response('OK') } }),
  },
};

export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'happy-backend API',
    version: '1.0.0',
    description:
      'Standalone backend for the Happy Restaurant POS system. All routes below /api/v1 except the ones marked no-auth ' +
      '(login, refresh, venue-config, health, this document) require a Bearer access token; the venue is always taken ' +
      'from the token, never from the request. Response envelope: success `{ data, meta }`, error `{ error: { code, message, details? } }` — ' +
      'clients must switch on `error.code`, never on `error.message`.',
  },
  servers: [{ url: '/api/v1' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas,
  },
  paths,
};
