import type { ErrorCode } from '../shared/errorCodes';

// The single canonical domain-error shape — replaces the ~13 module-local
// copies of this exact same {status, code, message} interface (OrderDomainError,
// MenuDomainError, TableDomainError, UserDomainError, ...). `code` is typed
// against the shared ErrorCode union so a typo or an undocumented code is a
// compile error, not a runtime surprise.
export interface DomainError {
  status: number;
  code: ErrorCode;
  message: string;
}

export function err(status: number, code: ErrorCode, message: string): DomainError {
  return { status, code, message };
}
