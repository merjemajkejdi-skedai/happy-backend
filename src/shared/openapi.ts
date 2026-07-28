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

  // ── Phase 2 resource schemas ────────────────────────────────────────────

  StockRow: {
    type: 'object',
    properties: {
      menuItemId: { type: 'string', format: 'uuid' },
      businessDate: { type: 'string', format: 'date' },
      startingQuantity: { type: 'integer' },
      remaining: { type: 'integer' },
      isOrderable: { type: 'boolean' },
    },
  },

  OrderCourse: {
    type: 'object',
    properties: {
      courseNumber: { type: 'integer' },
      status: { type: 'string', enum: ['pending', 'fired', 'served'] },
      firedAt: { type: ['string', 'null'], format: 'date-time' },
      firstReadyAt: { type: ['string', 'null'], format: 'date-time' },
      allServedAt: { type: ['string', 'null'], format: 'date-time' },
      itemCount: { type: 'integer' },
    },
  },

  VoidLog: {
    type: 'object',
    description: 'restaurant_void_log row — the append-only audit source for every void figure in reports.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      orderId: { type: 'string', format: 'uuid' },
      orderItemId: { type: ['string', 'null'], format: 'uuid' },
      stage: { type: 'string', enum: ['before_send', 'after_send'] },
      status: { type: 'string', enum: ['auto_approved', 'pending_approval', 'approved', 'rejected'] },
      reasonCode: { type: ['string', 'null'] },
      reasonText: { type: ['string', 'null'] },
      voidValue: money,
      requestedByUserId: { type: 'string', format: 'uuid' },
      requestedByName: { type: 'string' },
      resolvedByUserId: { type: ['string', 'null'], format: 'uuid' },
      rejectionReason: { type: ['string', 'null'] },
      businessDate: { type: 'string', format: 'date' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },

  Payment: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      orderId: { type: 'string', format: 'uuid' },
      method: { type: 'string', enum: ['cash', 'card', 'bank_transfer', 'voucher', 'room_charge', 'other'] },
      amount: money,
      tipAmount: money,
      receivedAmount: { type: ['number', 'null'], description: 'Cash only — what the guest handed over, for change calculation.' },
      reference: { type: ['string', 'null'] },
      isVoided: { type: 'boolean' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },

  Shift: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      businessDate: { type: 'string', format: 'date' },
      name: { type: ['string', 'null'] },
      status: { type: 'string', enum: ['open', 'closed'] },
      openedByUserId: { type: 'string', format: 'uuid' },
      openedAt: { type: 'string', format: 'date-time' },
      closedByUserId: { type: ['string', 'null'], format: 'uuid' },
      closedAt: { type: ['string', 'null'], format: 'date-time' },
      openingFloat: money,
      closingCashCounted: { type: ['number', 'null'] },
      cashVariance: { type: ['number', 'null'] },
      notes: { type: ['string', 'null'] },
    },
  },

  ReportPayload: {
    type: 'object',
    description: 'The full computeReport() output — see docs/phase2/REPORT-PAYLOAD.md for the authoritative field-by-field spec and computation rules. Every figure derives from snapshot columns; a finalized report (is_final=true) is served verbatim, never recomputed.',
    properties: {
      period: {
        type: 'object',
        properties: {
          start: { type: 'string', format: 'date-time' },
          end: { type: 'string', format: 'date-time' },
          business_dates: { type: 'array', items: { type: 'string', format: 'date' } },
        },
      },
      shift: { type: ['object', 'null'], description: 'null for a multi-shift range report.' },
      revenue: { type: 'object' },
      orders: { type: 'object' },
      covers: { type: 'object' },
      waiters: { type: 'array', items: { type: 'object' } },
      voids: { type: 'object' },
      payments: { type: 'object' },
      top_items: { type: 'array', items: { type: 'object' } },
      destinations: { type: 'object' },
      courses: { type: ['object', 'null'], description: 'null for happy_bar venues.' },
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
    responses: { '200': response('OK', envelope({ type: 'object' })), ...errorResponses, ...opts.responses },
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
    get: op('Liveness check', ['System'], {
      security: [],
      responses: {
        '200': response('OK', {
          type: 'object',
          required: ['status', 'ts'],
          properties: { status: { type: 'string', enum: ['ok'] }, ts: { type: 'string', format: 'date-time' } },
        }),
      },
    }),
  },

  // ── Auth ─────────────────────────────────────────────────────────────────
  '/auth/login/pin': {
    post: op('Log in with venue_slug + PIN', ['Auth'], {
      security: [],
      requestBody: { type: 'object', required: ['venue_slug', 'pin'], properties: { venue_slug: { type: 'string' }, pin: { type: 'string' } } },
      responses: {
        '200': response('OK', envelope({
        type: 'object',
        properties: {
          access_token: { type: 'string' },
          refresh_token: { type: 'string' },
          refresh_expires_at: { type: 'string', format: 'date-time' },
          user: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, fullName: { type: 'string' }, email: { type: ['string', 'null'] }, role: { type: 'string' }, venueId: { type: 'string', format: 'uuid' } } },
          venue: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, slug: { type: 'string' }, name: { type: 'string' }, venueType: { type: 'string' } } },
        },
      })),
        '429': response('Rate limited — 10 attempts/min per venue_slug+IP', errorEnvelope),
      },
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
      responses: {
        '200': response('OK', envelope({
        type: 'object',
        properties: {
          access_token: { type: 'string' },
          refresh_token: { type: 'string' },
          refresh_expires_at: { type: 'string', format: 'date-time' },
          user: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, fullName: { type: 'string' }, email: { type: ['string', 'null'] }, role: { type: 'string' }, venueId: { type: 'string', format: 'uuid' } } },
          venue: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, slug: { type: 'string' }, name: { type: 'string' }, venueType: { type: 'string' } } },
        },
      })),
        '429': response('Rate limited — 10 attempts/min per venue_slug+IP', errorEnvelope),
      },
    }),
  },
  '/auth/refresh': {
    post: op('Rotate an access/refresh token pair', ['Auth'], {
      security: [],
      requestBody: { type: 'object', required: ['refresh_token'], properties: { refresh_token: { type: 'string' } } },
      responses: {
        '200': response('OK', envelope({
          type: 'object',
          properties: {
            access_token: { type: 'string' },
            refresh_token: { type: 'string' },
            refresh_expires_at: { type: 'string', format: 'date-time' },
          },
        })),
      },
    }),
  },
  '/auth/logout': {
    post: op('Revoke a refresh token', ['Auth'], {
      requestBody: { type: 'object', required: ['refresh_token'], properties: { refresh_token: { type: 'string' } } },
      responses: { '200': response('OK', envelope({ type: 'object', properties: { loggedOut: { type: 'boolean' } } })) },
    }),
  },
  '/auth/me': {
    get: op('Current user + venue + settings', ['Auth'], {
      responses: {
        '200': response('OK', envelope({
          type: 'object',
          properties: {
            user: { $ref: '#/components/schemas/User' },
            venue: { $ref: '#/components/schemas/Venue' },
            settings: { $ref: '#/components/schemas/RestaurantSettings' },
          },
        })),
      },
    }),
  },
  '/auth/venue-config': {
    get: op('Public venue lookup by slug — login_method, locale, currency only', ['Auth'], {
      security: [],
      parameters: [queryParam('slug')],
      responses: {
        '200': response('OK', envelope({
          type: 'object',
          properties: {
            name: { type: 'string' },
            venue_type: { type: 'string' },
            login_method: { type: 'string' },
            locale: { type: 'string' },
            currency: { type: 'string' },
          },
        })),
      },
    }),
  },

  // ── Venue ────────────────────────────────────────────────────────────────
  '/venue': {
    get: op('Get this venue', ['Venue'], { responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/Venue' })) } }),
    patch: op('Update venue identity/contact fields (requires venue.write)', ['Venue'], {
      requestBody: { type: 'object', description: 'name, timezone, currency, locale, address, phone, is_active — venue_type is not editable.' },
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/Venue' })) },
    }),
  },

  // ── Settings ─────────────────────────────────────────────────────────────
  '/settings': {
    get: op('Get restaurant_settings', ['Settings'], { responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/RestaurantSettings' })) } }),
    patch: op('Update settings (requires settings.write) — validated against the merged current+patch state', ['Settings'], {
      requestBody: { type: 'object', description: 'Any subset of the editable settings fields.' },
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/RestaurantSettings' })) },
    }),
  },

  // ── Users ────────────────────────────────────────────────────────────────
  '/users': {
    get: op('List staff (requires user.manage)', ['Users'], {
      parameters: [...paginationParams, queryParam('role'), queryParam('is_active', { type: 'boolean' })],
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/User' } }, paginationMeta)) },
    }),
    post: op('Create a staff account (requires user.manage; managers may only create waiter/kitchen/bar — see INSUFFICIENT_ROLE_AUTHORITY)', ['Users'], {
      requestBody: {
        type: 'object',
        required: ['full_name', 'role'],
        properties: {
          full_name: { type: 'string' },
          role: { type: 'string', enum: ['waiter', 'kitchen', 'admin', 'manager', 'bar'] },
          email: { type: 'string' },
          password: { type: 'string' },
          pin: { type: 'string' },
        },
      },
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/User' })) },
    }),
  },
  '/users/roles': {
    get: op('Roles the current user is allowed to assign (requires user.manage) — all five for admin, waiter/kitchen/bar for manager', ['Users'], {
      responses: { '200': response('OK', envelope({ type: 'object', properties: { roles: { type: 'array', items: { type: 'string' } } } })) },
    }),
  },
  '/users/{id}': {
    get: op('Get a staff account (requires user.manage)', ['Users'], {
      parameters: [pathParam('id', 'User id')],
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/User' })) },
    }),
    patch: op('Update a staff account (requires user.manage)', ['Users'], {
      parameters: [pathParam('id', 'User id')],
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/User' })) },
    }),
    delete: op('Soft-delete a staff account (requires user.manage)', ['Users'], {
      parameters: [pathParam('id', 'User id')],
      responses: { '200': response('OK', envelope({ type: 'object', properties: { deleted: { type: 'boolean' } } })) },
    }),
  },
  '/users/{id}/role': {
    patch: op('Change a staff account\'s role (requires user.manage, subject to the same manager restriction as PATCH /users/{id})', ['Users'], {
      parameters: [pathParam('id', 'User id')],
      requestBody: { type: 'object', required: ['role'], properties: { role: { type: 'string', enum: ['waiter', 'kitchen', 'admin', 'manager', 'bar'] } } },
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/User' })) },
    }),
  },
  '/users/{id}/reset-pin': {
    post: op('Reset a user\'s PIN (requires user.manage)', ['Users'], {
      parameters: [pathParam('id', 'User id')],
      requestBody: { type: 'object', required: ['pin'], properties: { pin: { type: 'string' } } },
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/User' })) },
    }),
  },
  '/users/{id}/reset-password': {
    post: op('Reset a user\'s password (requires user.manage; user must have an email on file)', ['Users'], {
      parameters: [pathParam('id', 'User id')],
      requestBody: { type: 'object', required: ['password'], properties: { password: { type: 'string' } } },
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/User' })) },
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
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/Area' })) },
    }),
  },
  '/areas/{id}': {
    patch: op('Update an area (requires table.write)', ['Areas'], {
      parameters: [pathParam('id', 'Area id')],
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/Area' })) },
    }),
    delete: op('Soft-delete an area (requires table.write) — pass ?reassign_to= if it has active tables', ['Areas'], {
      parameters: [pathParam('id', 'Area id'), queryParam('reassign_to')],
      responses: { '200': response('OK', envelope({ type: 'object', properties: { deleted: { type: 'boolean' } } })) },
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
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/Table' })) },
    }),
  },
  '/tables/bulk': {
    post: op('Bulk-create a numeric range of tables (requires table.write, max 500)', ['Tables'], {
      requestBody: { type: 'object', required: ['area_id', 'from', 'to'], properties: { area_id: { type: 'string' }, from: { type: 'integer' }, to: { type: 'integer' } } },
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/Table' } })) },
    }),
  },
  '/tables/{id}': {
    get: op('Get a table', ['Tables'], {
      parameters: [pathParam('id', 'Table id')],
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/Table' })) },
    }),
    patch: op('Update a table (requires table.write)', ['Tables'], {
      parameters: [pathParam('id', 'Table id')],
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/Table' })) },
    }),
    delete: op('Soft-delete a table (requires table.write) — blocked if it has an active order', ['Tables'], {
      parameters: [pathParam('id', 'Table id')],
      responses: { '200': response('OK', envelope({ type: 'object', properties: { deleted: { type: 'boolean' } } })) },
    }),
  },
  '/tables/{id}/status': {
    patch: op('Set a table\'s status directly (requires table.status)', ['Tables'], {
      parameters: [pathParam('id', 'Table id')],
      requestBody: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['free', 'occupied', 'reserved', 'dirty'] } } },
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/Table' })) },
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
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/MenuCategory' })) },
    }),
  },
  '/menu/categories/{id}': {
    patch: op('Update a category (requires menu.write)', ['Menu'], {
      parameters: [pathParam('id', 'Category id')],
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/MenuCategory' })) },
    }),
    delete: op('Soft-delete a category (requires menu.write) — 409 if it has active items', ['Menu'], {
      parameters: [pathParam('id', 'Category id')],
      responses: { '200': response('OK', envelope({ type: 'object', properties: { deleted: { type: 'boolean' } } })) },
    }),
  },
  '/menu/items': {
    get: op('List menu items', ['Menu'], {
      parameters: [...paginationParams, queryParam('category_id'), queryParam('is_available', { type: 'boolean' }), queryParam('search')],
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/MenuItem' } }, paginationMeta)) },
    }),
    post: op('Create an item (requires menu.write) — destination/course inherit from the category unless overridden', ['Menu'], {
      requestBody: { type: 'object', required: ['category_id', 'name', 'price'], properties: { category_id: { type: 'string' }, name: { type: 'string' }, price: { type: 'number' } } },
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/MenuItem' })) },
    }),
  },
  '/menu/items/{id}': {
    get: op('Get a menu item', ['Menu'], {
      parameters: [pathParam('id', 'Item id')],
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/MenuItem' })) },
    }),
    patch: op('Update an item (requires menu.write)', ['Menu'], {
      parameters: [pathParam('id', 'Item id')],
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/MenuItem' })) },
    }),
    delete: op('Soft-delete an item (requires menu.write)', ['Menu'], {
      parameters: [pathParam('id', 'Item id')],
      responses: { '200': response('OK', envelope({ type: 'object', properties: { deleted: { type: 'boolean' } } })) },
    }),
  },
  '/menu/items/{id}/availability': {
    patch: op('The "86" toggle (requires menu.availability — waiter, kitchen, and admin)', ['Menu'], {
      parameters: [pathParam('id', 'Item id')],
      requestBody: { type: 'object', required: ['is_available'], properties: { is_available: { type: 'boolean' } } },
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/MenuItem' })) },
    }),
  },
  '/menu/items/{id}/modifier-groups': {
    get: op('Modifier groups attached to this item, with their options (requires menu.view)', ['Menu'], {
      parameters: [pathParam('id', 'Item id')],
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/ModifierGroup' } })) },
    }),
    post: op('Replace the full set of modifier groups attached to this item (requires menu.write)', ['Menu'], {
      parameters: [pathParam('id', 'Item id')],
      requestBody: { type: 'object', required: ['group_ids'], properties: { group_ids: { type: 'array', items: { type: 'string' } } } },
      responses: {
        '200': response('OK', envelope({
          type: 'array',
          items: { type: 'object', properties: { groupId: { type: 'string', format: 'uuid' }, sortOrder: { type: 'integer' } } },
        })),
      },
    }),
  },
  '/menu/modifier-groups': {
    get: op('List modifier groups with their options', ['Menu'], {
      parameters: paginationParams,
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/ModifierGroup' } }, paginationMeta)) },
    }),
    post: op('Create a modifier group (requires menu.write)', ['Menu'], {
      requestBody: { type: 'object', required: ['name', 'type'], properties: { name: { type: 'string' }, type: { type: 'string', enum: ['single', 'multiple'] } } },
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/ModifierGroup' })) },
    }),
  },
  '/menu/modifier-groups/{id}': {
    patch: op('Update a modifier group (requires menu.write)', ['Menu'], {
      parameters: [pathParam('id', 'Group id')],
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/ModifierGroup' })) },
    }),
    delete: op('Soft-delete a modifier group (requires menu.write)', ['Menu'], {
      parameters: [pathParam('id', 'Group id')],
      responses: { '200': response('OK', envelope({ type: 'object', properties: { deleted: { type: 'boolean' } } })) },
    }),
  },
  '/menu/modifier-groups/{id}/options': {
    post: op('Add an option to a group (requires menu.write)', ['Menu'], {
      parameters: [pathParam('id', 'Group id')],
      requestBody: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, price_delta: { type: 'number' } } },
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/ModifierOption' })) },
    }),
  },
  '/menu/modifier-options/{id}': {
    patch: op('Update a modifier option (requires menu.write)', ['Menu'], {
      parameters: [pathParam('id', 'Option id')],
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/ModifierOption' })) },
    }),
    delete: op('Soft-delete a modifier option (requires menu.write)', ['Menu'], {
      parameters: [pathParam('id', 'Option id')],
      responses: { '200': response('OK', envelope({ type: 'object', properties: { deleted: { type: 'boolean' } } })) },
    }),
  },

  // ── Menu — stock & 86 (Phase 2, session 2e) ─────────────────────────────
  '/menu/items/{id}/86': {
    post: op('86 an item — mark unavailable, with an optional reason (requires menu.eightysix, settings-resolved)', ['Menu'], {
      parameters: [pathParam('id', 'Item id')],
      requestBody: { type: 'object', properties: { reason: { type: 'string' } } },
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/StockRow' })) },
    }),
  },
  '/menu/items/{id}/restore': {
    post: op('Restore a stock-86\'d item to orderable (requires menu.eightysix, settings-resolved)', ['Menu'], {
      parameters: [pathParam('id', 'Item id')],
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/StockRow' })) },
    }),
  },
  '/menu/items/{id}/stock': {
    patch: op('Set today\'s starting stock ({starting_quantity}) or adjust an existing baseline ({delta}) (requires menu.stock) — 422 ITEM_NOT_STOCK_TRACKED with no baseline yet', ['Menu'], {
      parameters: [pathParam('id', 'Item id')],
      requestBody: { type: 'object', properties: { starting_quantity: { type: 'integer' }, delta: { type: 'integer' } } },
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/StockRow' })) },
    }),
  },
  '/menu/stock': {
    get: op('Today\'s stock levels for every tracked item (requires menu.view)', ['Menu'], {
      parameters: [queryParam('business_date')],
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/StockRow' } })) },
    }),
  },
  '/menu/stock/movements': {
    get: op('Paginated stock movement ledger (requires reports.view)', ['Menu'], {
      parameters: [...paginationParams, queryParam('menu_item_id'), queryParam('from'), queryParam('to')],
      responses: { '200': response('OK', envelope({ type: 'array', items: { type: 'object' } }, paginationMeta)) },
    }),
  },
  '/menu/stock/low': {
    get: op('Items at or below their low-stock threshold today (requires menu.view)', ['Menu'], {
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/StockRow' } })) },
    }),
  },
  '/menu/stock/bulk-set': {
    post: op('Set today\'s starting stock for many items at once (requires menu.stock)', ['Menu'], {
      requestBody: {
        type: 'object',
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            items: { type: 'object', properties: { menu_item_id: { type: 'string' }, starting_quantity: { type: 'integer' } } },
          },
        },
      },
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/StockRow' } })) },
    }),
  },
  '/menu/stock/day-open': {
    post: op('Roll every stock-tracked item\'s remaining quantity forward onto a new business date (requires menu.stock)', ['Menu'], {
      requestBody: { type: 'object', properties: { business_date: { type: 'string' } } },
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/StockRow' } })) },
    }),
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
    patch: op('Update guest_count/customer_name/notes only (requires order.create)', ['Orders'], {
      parameters: [pathParam('id', 'Order id')],
      responses: { '200': response('OK', envelope(orderSchema)) },
    }),
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
      responses: { '200': response('OK', envelope({ type: 'object', properties: { deleted: { type: 'boolean' } } })) },
    }),
  },
  '/orders/{id}/items/{itemId}/serve': {
    patch: op('Mark one ready item served (requires order.serve)', ['Orders'], {
      parameters: [pathParam('id', 'Order id'), pathParam('itemId', 'Order item id')],
      responses: { '200': response('OK', envelope({ type: 'object', properties: { served: { type: 'boolean' } } })) },
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
      responses: { '200': response('OK', envelope({ type: 'object', properties: { served: { type: 'integer' } } })) },
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

  // ── Orders — course firing (Phase 2, session 2c) ────────────────────────
  '/orders/{id}/courses': {
    get: op('Course state for every course with at least one item assigned (requires order.create) — 403 COURSES_NOT_AVAILABLE_FOR_VENUE_TYPE unless send_by_course and venue_type in (happy_restaurant, happy_hybrid)', ['Orders'], {
      parameters: [pathParam('id', 'Order id')],
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/OrderCourse' } })) },
    }),
  },
  '/orders/{id}/courses/{n}/fire': {
    post: op('Send a course\'s pending items to kitchen/bar — reuses the same send logic as POST /orders/:id/send (requires order.fire)', ['Orders'], {
      parameters: [pathParam('id', 'Order id'), pathParam('n', 'Course number'), idempotencyKeyHeader],
      responses: { '200': response('OK', envelope({ type: 'object' })) },
    }),
  },
  '/orders/{id}/courses/{n}/hold': {
    post: op('Un-fire a course — reverts its sent items to pending — only while nothing in it has progressed past sent (requires order.fire)', ['Orders'], {
      parameters: [pathParam('id', 'Order id'), pathParam('n', 'Course number')],
      responses: { '200': response('OK', envelope({ type: 'object' })) },
    }),
  },
  '/orders/{id}/courses/reorder': {
    post: op('Reassign course numbers by a full permutation of the order\'s existing ones (requires order.fire)', ['Orders'], {
      parameters: [pathParam('id', 'Order id')],
      requestBody: { type: 'object', required: ['course_numbers'], properties: { course_numbers: { type: 'array', items: { type: 'integer' } } } },
      responses: { '200': response('OK', envelope({ type: 'object' })) },
    }),
  },
  '/orders/{id}/items/{itemId}/course': {
    patch: op('Move an item to a different course — only while pending (requires order.create)', ['Orders'], {
      parameters: [pathParam('id', 'Order id'), pathParam('itemId', 'Order item id')],
      requestBody: { type: 'object', properties: { course_number: { type: ['integer', 'null'] } } },
      responses: { '200': response('OK', envelope({ type: 'object', properties: { moved: { type: 'boolean' } } })) },
    }),
  },

  // ── Orders — void request/approval (Phase 2, session 2d-i) ──────────────
  '/orders/{id}/items/{itemId}/void': {
    post: op('Request a void — auto-approved and cancelled immediately, or queued pending_approval per resolveVoidPolicy (requires order.void)', ['Orders'], {
      parameters: [pathParam('id', 'Order id'), pathParam('itemId', 'Order item id'), idempotencyKeyHeader],
      requestBody: { type: 'object', properties: { reason_code: { type: 'string' }, reason_text: { type: 'string' } } },
      responses: {
        '200': response('OK — cancelled immediately', envelope({ type: 'object', properties: { pending: { type: 'boolean', enum: [false] }, void: { $ref: '#/components/schemas/VoidLog' } } })),
        '202': response('Accepted — queued for approval', envelope({ type: 'object', properties: { pending: { type: 'boolean', enum: [true] }, void: { $ref: '#/components/schemas/VoidLog' } } })),
      },
    }),
  },

  // ── Orders — split (Phase 2, sessions 2f-i/2f-ii) ────────────────────────
  '/orders/{id}/split': {
    post: op('Split a bill — equal / by_item / by_seat (requires order.split, gated by split_bill_enabled) — see docs/phase2/SESSION-2f-i.md and SESSION-2f-ii.md for each mode\'s payload', ['Orders'], {
      parameters: [pathParam('id', 'Order id'), idempotencyKeyHeader],
      requestBody: {
        type: 'object',
        required: ['split_type'],
        properties: {
          split_type: { type: 'string', enum: ['equal', 'by_item', 'by_seat'] },
          ways: { type: 'integer', description: 'split_type=equal only.' },
          allocations: {
            type: 'array',
            description: 'split_type=by_item only.',
            items: { type: 'object', properties: { order_item_ids: { type: 'array', items: { type: 'string' } }, label: { type: 'string' } } },
          },
        },
      },
      responses: { '200': response('OK — every resulting order (parent + children, or the two by_seat orders)', envelope({ type: 'array', items: orderSchema })) },
    }),
  },
  '/orders/{id}/splits': {
    get: op('List the parent + all split children for this order (requires order.view_own)', ['Orders'], {
      parameters: [pathParam('id', 'Order id')],
      responses: { '200': response('OK', envelope({ type: 'array', items: orderSchema })) },
    }),
  },
  '/orders/{id}/splits/{childId}/merge-back': {
    post: op('Undo a split — fold an unpaid child back into its parent (requires order.split)', ['Orders'], {
      parameters: [pathParam('id', 'Order id'), pathParam('childId', 'Split child order id')],
      responses: { '200': response('OK', envelope({ type: 'object', properties: { merged: { type: 'boolean' } } })) },
    }),
  },

  // ── Orders — merge (Phase 2, session 2f-iii) ─────────────────────────────
  '/orders/{id}/merge-preview': {
    get: op('Preview a merge without applying it (requires order.merge). {id} is the target/survivor; source_order_id is absorbed and left status=merged.', ['Orders'], {
      parameters: [pathParam('id', 'Order id (target/survivor)'), queryParam('source_order_id'), queryParam('target_table_id')],
      responses: { '200': response('OK', envelope({ type: 'object' })) },
    }),
  },
  '/orders/{id}/merge': {
    post: op('Merge source_order_id into this order — the source becomes status=merged (requires order.merge, order.merge_approve too if merge_requires_manager)', ['Orders'], {
      parameters: [pathParam('id', 'Order id (target/survivor)'), idempotencyKeyHeader],
      requestBody: { type: 'object', required: ['source_order_id'], properties: { source_order_id: { type: 'string' }, target_table_id: { type: 'string' } } },
      responses: { '200': response('OK', envelope({ type: 'object', properties: { target: orderSchema, source: orderSchema } })) },
    }),
  },

  // ── Orders — payments (Phase 2, session 2g-i) ────────────────────────────
  '/orders/{id}/payments': {
    get: op('List payments on this order, including voided ones (requires order.view_own)', ['Orders'], {
      parameters: [pathParam('id', 'Order id')],
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/Payment' } })) },
    }),
    post: op('Record a payment against amount_due (requires order.payment) — cash is the only method allowed to exceed amount_due', ['Orders'], {
      parameters: [pathParam('id', 'Order id'), idempotencyKeyHeader],
      requestBody: {
        type: 'object',
        required: ['method', 'amount'],
        properties: {
          method: { type: 'string', enum: ['cash', 'card', 'bank_transfer', 'voucher', 'room_charge', 'other'] },
          amount: { type: 'number' },
          tip_amount: { type: 'number' },
          reference: { type: 'string' },
          received_amount: { type: 'number', description: 'Cash only — for change calculation.' },
        },
      },
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/Payment' })) },
    }),
  },
  '/orders/{id}/payments/{pid}': {
    delete: op('Void a payment (requires order.payment_void) — reason required', ['Orders'], {
      parameters: [pathParam('id', 'Order id'), pathParam('pid', 'Payment id')],
      requestBody: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } },
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/Payment' })) },
    }),
  },

  // ── Displays ─────────────────────────────────────────────────────────────
  '/displays/kitchen': {
    get: op('Kitchen display tickets (requires display.view) — 403 if kitchen_display_enabled is false', ['Displays'], {
      parameters: [queryParam('course_number', { type: 'integer' }), queryParam('include_ready', { type: 'boolean' })],
      responses: {
        '200': response('OK', envelope({
          type: 'object',
          properties: {
            tickets: { type: 'array', items: { $ref: '#/components/schemas/DisplayTicket' } },
            fire_alerts: { type: 'array', items: { type: 'object' }, description: 'Always present, empty when none apply. Phase 2, session 2c.' },
            void_alerts: { type: 'array', items: { type: 'object' }, description: 'Always present, empty when none apply. Phase 2, session 2d-ii.' },
          },
        }, { $ref: '#/components/schemas/DisplayMeta' })),
      },
    }),
  },
  '/displays/bar': {
    get: op('Bar display tickets (requires display.view) — 403 if bar_display_enabled is false', ['Displays'], {
      parameters: [queryParam('course_number', { type: 'integer' }), queryParam('include_ready', { type: 'boolean' })],
      responses: {
        '200': response('OK', envelope({
          type: 'object',
          properties: {
            tickets: { type: 'array', items: { $ref: '#/components/schemas/DisplayTicket' } },
            fire_alerts: { type: 'array', items: { type: 'object' }, description: 'Always present, empty when none apply. Phase 2, session 2c.' },
            void_alerts: { type: 'array', items: { type: 'object' }, description: 'Always present, empty when none apply. Phase 2, session 2d-ii.' },
          },
        }, { $ref: '#/components/schemas/DisplayMeta' })),
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
      responses: { '200': response('OK', envelope({ type: 'object', properties: { updated: { type: 'boolean' } } })) },
    }),
  },
  '/displays/bump': {
    post: op('Bulk transition to ready in one transaction (requires display.bump) — explicit item_ids is all-or-nothing, order_id auto-resolves eligible items', ['Displays'], {
      requestBody: { type: 'object', properties: { order_item_ids: { type: 'array', items: { type: 'string' } }, order_id: { type: 'string' }, status: { type: 'string', enum: ['ready'] } } },
      responses: { '200': response('OK', envelope({ type: 'object', properties: { bumped: { type: 'integer' } } })) },
    }),
  },
  '/displays/items/{itemId}/recall': {
    post: op('Un-bump a mistake: ready -> preparing, clears ready_at (requires display.bump)', ['Displays'], {
      parameters: [pathParam('itemId', 'Order item id')],
      responses: { '200': response('OK', envelope({ type: 'object', properties: { recalled: { type: 'boolean' } } })) },
    }),
  },

  // ── Displays — fire alerts (Phase 2, session 2c) ────────────────────────
  '/displays/kitchen/fire-alerts': {
    get: op('Unacknowledged course-fire alerts within show_fire_alert_seconds (requires display.view, gated by send_by_course)', ['Displays'], {
      responses: { '200': response('OK', envelope({ type: 'array', items: { type: 'object' } })) },
    }),
  },
  '/displays/fire-alerts/{id}/ack': {
    post: op('Acknowledge (dismiss) a fire alert — {id} is the underlying order_courses id (requires display.bump)', ['Displays'], {
      parameters: [pathParam('id', 'order_courses id')],
      responses: { '200': response('OK', envelope({ type: 'object', properties: { acknowledged: { type: 'boolean' } } })) },
    }),
  },

  // ── Displays — void alerts (Phase 2, session 2d-ii) ─────────────────────
  '/displays/void-alerts': {
    get: op('Unacknowledged after-send void alerts, kitchen and bar combined (requires display.view, gated by void_alerts_kitchen)', ['Displays'], {
      responses: { '200': response('OK', envelope({ type: 'array', items: { type: 'object' } })) },
    }),
  },
  '/displays/void-alerts/{id}/ack': {
    post: op('Acknowledge (dismiss) a void alert — {id} is the underlying restaurant_void_log id (requires display.bump)', ['Displays'], {
      parameters: [pathParam('id', 'restaurant_void_log id')],
      responses: { '200': response('OK', envelope({ type: 'object', properties: { acknowledged: { type: 'boolean' } } })) },
    }),
  },

  // ── Permissions (Phase 2, session 2a-ii) ────────────────────────────────
  '/permissions': {
    get: op('Resolved permission matrix + display scope for the current user\'s role and venue — reflects settings-dependent resolution, not the static ceiling. What the frontend gates on.', ['Permissions'], {
      responses: {
        '200': response('OK', envelope({
          type: 'object',
          properties: {
            role: { type: 'string', enum: ['waiter', 'kitchen', 'admin', 'manager', 'bar'] },
            permissions: { type: 'array', items: { type: 'string' } },
            display_scope: { type: 'object', properties: { kitchen: { type: 'boolean' }, bar: { type: 'boolean' } } },
          },
        })),
      },
    }),
  },

  // ── Voids (Phase 2, session 2d-i, list/approve routes) ──────────────────
  '/voids/pending': {
    get: op('Paginated void requests awaiting approval (requires void.approve)', ['Voids'], {
      parameters: paginationParams,
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/VoidLog' } }, paginationMeta)) },
    }),
  },
  '/voids': {
    get: op('Paginated void request history (requires reports.view, settings-resolved)', ['Voids'], {
      parameters: [...paginationParams, queryParam('from'), queryParam('to'), queryParam('status'), queryParam('user_id')],
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/VoidLog' } }, paginationMeta)) },
    }),
  },
  '/voids/{id}': {
    get: op('Get a void request (requires reports.view, settings-resolved)', ['Voids'], {
      parameters: [pathParam('id', 'Void request id')],
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/VoidLog' })) },
    }),
  },
  '/voids/{id}/approve': {
    post: op('Approve a pending void request (requires void.approve)', ['Voids'], {
      parameters: [pathParam('id', 'Void request id')],
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/VoidLog' })) },
    }),
  },
  '/voids/{id}/reject': {
    post: op('Reject a pending void request — the item stays live (requires void.approve)', ['Voids'], {
      parameters: [pathParam('id', 'Void request id')],
      requestBody: { type: 'object', properties: { rejection_reason: { type: 'string' } } },
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/VoidLog' })) },
    }),
  },

  // ── Shifts (Phase 2, session 2g-ii) ──────────────────────────────────────
  '/shifts/open': {
    post: op('Open a new shift for this venue — one open at a time (requires shift.manage)', ['Shifts'], {
      requestBody: { type: 'object', properties: { name: { type: 'string' }, opening_float: { type: 'number' } } },
      responses: {
        '200': response('OK', envelope({ $ref: '#/components/schemas/Shift' })),
        '409': response('A shift is already open (SHIFT_ALREADY_OPEN)', errorEnvelope),
      },
    }),
  },
  '/shifts/close': {
    post: op('Close the open shift and materialize its final report (requires shift.manage) — pass ?force=true to close over still-open orders', ['Shifts'], {
      parameters: [queryParam('force', { type: 'boolean' })],
      requestBody: { type: 'object', properties: { closing_cash_counted: { type: 'number' }, notes: { type: 'string' } } },
      responses: {
        '200': response('OK', envelope({ $ref: '#/components/schemas/Shift' })),
        '409': response('Open orders remain and force was not set (SHIFT_HAS_OPEN_ORDERS) — error.details.open_orders lists them', errorEnvelope),
      },
    }),
  },
  '/shifts/current': {
    get: op('The open shift, if any, plus whether it has run past shift_auto_close_hours (requires reports.view, settings-resolved)', ['Shifts'], {
      responses: {
        '200': response('OK', envelope({
          type: 'object',
          properties: { shift: { anyOf: [{ $ref: '#/components/schemas/Shift' }, { type: 'null' }] }, flagged: { type: 'boolean' } },
        })),
      },
    }),
  },
  '/shifts': {
    get: op('Paginated shift history (requires reports.view, settings-resolved)', ['Shifts'], {
      parameters: [...paginationParams, queryParam('from'), queryParam('to')],
      responses: { '200': response('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/Shift' } }, paginationMeta)) },
    }),
  },
  '/shifts/{id}': {
    get: op('Get a shift (requires reports.view, settings-resolved)', ['Shifts'], {
      parameters: [pathParam('id', 'Shift id')],
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/Shift' })) },
    }),
  },

  // ── Reports (Phase 2, sessions 2h-i/2h-ii) ───────────────────────────────
  // Every route projects from the same computeReport(venueId, periodStart,
  // periodEnd, shiftId?) — see docs/phase2/REPORT-PAYLOAD.md and
  // docs/phase2/SESSION-2h-i.md/SESSION-2h-ii.md. Scope is resolved from
  // either ?shift_id or ?from&to (business dates, both default to "today"),
  // shared across every route below except GET /reports/shift/{id}.
  '/reports/shift/{id}': {
    get: op('The stored final report for this shift, or a live preview if it\'s still open (requires reports.view, settings-resolved)', ['Reports'], {
      parameters: [pathParam('id', 'Shift id')],
      responses: { '200': response('OK', envelope({ $ref: '#/components/schemas/ReportPayload' })) },
    }),
  },
  '/reports/range': {
    get: op('A report over ?from&to or ?shift_id — optionally ?group_by=day|shift|waiter (requires reports.view, settings-resolved)', ['Reports'], {
      parameters: [queryParam('from'), queryParam('to'), queryParam('shift_id'), queryParam('group_by')],
      responses: {
        '200': response(
          'OK — one ReportPayload with no group_by; report.waiters alone for group_by=waiter; an array of {business_date, report} or {shift_id, report} for group_by=day|shift',
          envelope({}),
        ),
      },
    }),
  },
  '/reports/sales': {
    get: op('{revenue, orders, covers} for the resolved scope (requires reports.view, settings-resolved)', ['Reports'], {
      parameters: [queryParam('from'), queryParam('to'), queryParam('shift_id')],
      responses: { '200': response('OK', envelope({ type: 'object' })) },
    }),
  },
  '/reports/waiters': {
    get: op('report.waiters for the resolved scope (requires reports.view, settings-resolved)', ['Reports'], {
      parameters: [queryParam('from'), queryParam('to'), queryParam('shift_id')],
      responses: { '200': response('OK', envelope({ type: 'array', items: { type: 'object' } })) },
    }),
  },
  '/reports/voids': {
    get: op('report.voids for the resolved scope (requires reports.view, settings-resolved)', ['Reports'], {
      parameters: [queryParam('from'), queryParam('to'), queryParam('shift_id')],
      responses: { '200': response('OK', envelope({ type: 'object' })) },
    }),
  },
  '/reports/items': {
    get: op('report.top_items re-sorted by ?sort=quantity|revenue (default revenue), capped at ?limit (default 20, max 200) (requires reports.view, settings-resolved)', ['Reports'], {
      parameters: [queryParam('from'), queryParam('to'), queryParam('shift_id'), queryParam('sort'), queryParam('limit', { type: 'integer' })],
      responses: { '200': response('OK', envelope({ type: 'array', items: { type: 'object' } })) },
    }),
  },
  '/reports/payments': {
    get: op('report.payments for the resolved scope (requires reports.view, settings-resolved)', ['Reports'], {
      parameters: [queryParam('from'), queryParam('to'), queryParam('shift_id')],
      responses: { '200': response('OK', envelope({ type: 'object' })) },
    }),
  },
  '/reports/generate': {
    post: op('Materialize the resolved scope into shift_reports (is_final=true) — always computed fresh, unlike GET /reports/shift/{id}\'s cache-first read (requires reports.view, settings-resolved)', ['Reports'], {
      parameters: [queryParam('from'), queryParam('to'), queryParam('shift_id')],
      responses: {
        '200': response('OK', envelope({
          type: 'object',
          properties: { shift_report_id: { type: 'string', format: 'uuid' }, report: { $ref: '#/components/schemas/ReportPayload' } },
        })),
      },
    }),
  },
  '/reports/export': {
    get: op('CSV or JSON export of one report section, byte-identical to its on-screen equivalent (requires reports.export, settings-resolved). Phase 2, session 2h-ii.', ['Reports'], {
      parameters: [
        queryParam('format', { type: 'string', enum: ['csv', 'json'] }),
        queryParam('section', { type: 'string', enum: ['sales', 'waiters', 'voids', 'items', 'payments'] }),
        queryParam('from'),
        queryParam('to'),
        queryParam('shift_id'),
      ],
      responses: {
        '200': {
          description: 'application/json (envelope-wrapped) when format=json; text/csv (raw, Content-Disposition: attachment) when format=csv. Shape depends on ?section — an array of rows for waiters/items, one object for sales/voids/payments.',
          content: {
            'application/json': { schema: envelope({}) },
            'text/csv': { schema: { type: 'string' } },
          },
        },
      },
    }),
  },

  // ── OpenAPI ──────────────────────────────────────────────────────────────
  '/openapi.json': {
    get: op('This document', ['System'], {
      security: [],
      responses: { '200': response('OK', { type: 'object', description: 'This OpenAPI 3.1 document itself.' }) },
    }),
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
