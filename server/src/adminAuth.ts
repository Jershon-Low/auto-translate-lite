import type { Request, Response, NextFunction, RequestHandler } from 'express';

export function createAdminAuth(passcode: string | undefined): RequestHandler {
  return function adminAuth(req: Request, res: Response, next: NextFunction): void {
    const provided = req.header('x-admin-passcode');
    if (!passcode || provided !== passcode) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}
