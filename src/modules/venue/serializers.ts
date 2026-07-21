import type { Venue } from '../../generated/prisma/client';

// pms_provider/pms_property_id/pms_config are schema-only, unused-in-Phase-1
// columns (mirrors the same PMS flag on restaurant_settings) — omitted
// entirely (never sent as null) while pms_enabled is false, matching
// settingsSerializer.ts's convention for whatsapp_config/ai_config.
export function serializeVenue<T extends Venue>(venue: T, pmsEnabled = false) {
  const { pmsProvider, pmsPropertyId, pmsConfig, ...rest } = venue;
  return {
    ...rest,
    ...(pmsEnabled ? { pmsProvider, pmsPropertyId, pmsConfig } : {}),
  };
}
