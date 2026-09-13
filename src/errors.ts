/** An error the client is expected to handle; rendered as `{ error, message }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export const unauthenticated = (): ApiError => new ApiError(401, 'unauthenticated', '请先登录。');
export const profileRequired = (): ApiError => new ApiError(403, 'profile_required', '请先完善资料。');
export const forbidden = (message = '没有权限。'): ApiError => new ApiError(403, 'forbidden', message);
export const notFound = (message = '找不到这个局。'): ApiError => new ApiError(404, 'not_found', message);
