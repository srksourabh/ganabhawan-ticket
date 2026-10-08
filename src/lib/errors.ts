/** `productId` names the cart line a checkout error belongs to (see createCheckout). */
export class AppError extends Error { constructor(public status: number, message: string, public code = 'INVALID_REQUEST', public productId?: string) { super(message); } }
export function requireValue(condition: unknown, message: string, status = 409): asserts condition { if (!condition) throw new AppError(status, message); }
