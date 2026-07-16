import { describe, it, expect, vi } from 'vitest';
import { createAdminAuth } from '../src/adminAuth';

function fakeReqRes(header: string | undefined) {
  const req = { header: vi.fn().mockReturnValue(header) } as any;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
  const next = vi.fn();
  return { req, res, next };
}

describe('createAdminAuth', () => {
  it('calls next() when the header matches the configured passcode', () => {
    const middleware = createAdminAuth('secret123');
    const { req, res, next } = fakeReqRes('secret123');
    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('responds 401 when the header is missing', () => {
    const middleware = createAdminAuth('secret123');
    const { req, res, next } = fakeReqRes(undefined);
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 401 when the header does not match', () => {
    const middleware = createAdminAuth('secret123');
    const { req, res, next } = fakeReqRes('wrong');
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed (401) when no passcode is configured at all, even if a header is sent', () => {
    const middleware = createAdminAuth(undefined);
    const { req, res, next } = fakeReqRes('anything');
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
