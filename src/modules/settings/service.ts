import { prisma } from '../../db/prisma';
import { logger } from '../../shared/logger';
import type { RestaurantSettings, Prisma } from '../../generated/prisma/client';
import type { ErrorCode } from '../../shared/errorCodes';

const EDITABLE_FIELDS = [
  'loginMethod', 'pinLength', 'sessionTimeoutMinutes', 'requirePinOnReopen',
  'tableNamingMode', 'tablesEnabled', 'counterServiceEnabled', 'ticketNumberPrefix',
  'ticketNumberReset', 'requireTableForOrder', 'allowTableTransfer', 'allowOrderMerge',
  'coursesEnabled', 'defaultCourseCount', 'modifiersEnabled', 'allowFreeTextNotes',
  'kitchenDisplayEnabled', 'barDisplayEnabled', 'kitchenPrinterEnabled', 'barPrinterEnabled',
  'displayAutoRefreshSeconds', 'displayShowElapsedTime', 'displayWarnAfterMinutes',
  'allowItemVoidAfterSend', 'requireReasonOnVoid', 'autoSendOnAdd',
  'whatsappEnabled', 'whatsappConfig', 'aiEnabled', 'aiConfig',
  'pmsEnabled', 'pmsRoomChargeEnabled', 'taxRatePercent', 'serviceChargePercent', 'extra',
] as const;

export type SettingsPatchInput = Partial<Record<(typeof EDITABLE_FIELDS)[number], unknown>>;

export interface SettingsValidationError {
  code: ErrorCode;
  message: string;
}

// Validated against the MERGED (current + patch) state, not just the raw
// patch — e.g. patching only counter_service_enabled still has to be checked
// against whatever tables_enabled currently is, and vice versa.
function validate(
  venueType: string,
  merged: Pick<RestaurantSettings, 'coursesEnabled' | 'tablesEnabled' | 'counterServiceEnabled' | 'requireTableForOrder' | 'pinLength'>,
): SettingsValidationError | null {
  if (venueType === 'happy_bar' && merged.coursesEnabled) {
    return { code: 'COURSES_NOT_ALLOWED_FOR_BAR', message: 'courses_enabled cannot be true for a happy_bar venue' };
  }
  if (!merged.tablesEnabled && !merged.counterServiceEnabled) {
    return { code: 'COUNTER_SERVICE_REQUIRED', message: 'counter_service_enabled must be true when tables_enabled is false' };
  }
  if (!merged.counterServiceEnabled && !merged.requireTableForOrder) {
    return { code: 'TABLE_REQUIRED_FOR_ORDER', message: 'require_table_for_order must be true when counter_service_enabled is false' };
  }
  if (merged.pinLength < 4 || merged.pinLength > 8) {
    return { code: 'PIN_LENGTH_OUT_OF_RANGE', message: 'pin_length must be between 4 and 8' };
  }
  return null;
}

export async function getSettingsRow(venueId: string): Promise<RestaurantSettings | null> {
  return prisma.restaurantSettings.findUnique({ where: { venueId } });
}

export type UpdateSettingsResult =
  | { ok: true; settings: RestaurantSettings }
  | { ok: false; error: SettingsValidationError };

export async function updateSettings(
  venueId: string,
  actorUserId: string,
  patch: SettingsPatchInput,
): Promise<UpdateSettingsResult> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId } });
  const current = await prisma.restaurantSettings.findUnique({ where: { venueId } });
  if (!venue || !current) throw new Error(`venue or settings not found for ${venueId}`);

  const merged = { ...current, ...patch } as RestaurantSettings;
  const error = validate(venue.venueType, merged);
  if (error) return { ok: false, error };

  // Enabling whatsapp/ai/pms only flips the boolean (and its config blob, if
  // supplied) — no side effects, no outbound calls. There is deliberately no
  // other code path here for those three flags.
  const data: Prisma.RestaurantSettingsUpdateInput = {};
  const changedFields: string[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in patch) {
      (data as Record<string, unknown>)[field] = patch[field];
      changedFields.push(field);
      before[field] = (current as unknown as Record<string, unknown>)[field];
      after[field] = patch[field];
    }
  }

  const settings = await prisma.restaurantSettings.update({ where: { venueId }, data });

  // Settings changes are not order_events (that table is for order state,
  // not venue configuration) — just a structured audit line for Phase 1.
  if (changedFields.length > 0) {
    logger.info({ event: 'settings.updated', venueId, actorUserId, fields: changedFields, before, after });
  }

  return { ok: true, settings };
}
