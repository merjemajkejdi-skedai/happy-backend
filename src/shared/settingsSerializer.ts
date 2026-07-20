import type { RestaurantSettings } from '../generated/prisma/client';

// Used by /auth/me now, and by GET /settings later — the one place that
// decides what a restaurant_settings row looks like on the wire. Fields
// belonging to a disabled optional integration are omitted entirely, never
// sent as null: whatsapp_config unless whatsapp_enabled, ai_config unless
// ai_enabled, pms_room_charge_enabled unless pms_enabled (pms_enabled itself
// is always present — it's the flag that gates the others, not gated itself).
export function serializeSettings(settings: RestaurantSettings): Record<string, unknown> {
  const { whatsappConfig, aiConfig, pmsRoomChargeEnabled, taxRatePercent, serviceChargePercent, ...rest } = settings;

  const out: Record<string, unknown> = {
    ...rest,
    // Prisma's Decimal serializes to a string by default (decimal.js
    // toJSON) — these are plain numbers on the wire, never client-trusted,
    // matching how every other money/percent field in this API behaves.
    taxRatePercent: Number(taxRatePercent),
    serviceChargePercent: Number(serviceChargePercent),
  };

  if (settings.whatsappEnabled) out.whatsappConfig = whatsappConfig;
  if (settings.aiEnabled) out.aiConfig = aiConfig;
  if (settings.pmsEnabled) out.pmsRoomChargeEnabled = pmsRoomChargeEnabled;

  return out;
}
