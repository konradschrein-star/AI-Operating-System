/**
 * App Router Route Handler: /api/proxy/[...path]
 *
 * Transparent HTTP reverse proxy to forge-control ($FORGE_CONTROL_URL/api/*).
 * Implementation lives in ./proxy-handler.ts — see that file for the "why".
 * This file re-exports only the HTTP-verb handlers Next.js's route typegen
 * recognizes; any other export here fails `tsc` against `.next/types/**`.
 */

import { handleProxy, type RouteContext } from "./proxy-handler";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: RouteContext): Promise<Response> {
  return handleProxy(req, ctx);
}

export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  return handleProxy(req, ctx);
}

export async function PUT(req: Request, ctx: RouteContext): Promise<Response> {
  return handleProxy(req, ctx);
}

export async function DELETE(req: Request, ctx: RouteContext): Promise<Response> {
  return handleProxy(req, ctx);
}

export async function PATCH(req: Request, ctx: RouteContext): Promise<Response> {
  return handleProxy(req, ctx);
}

export async function OPTIONS(req: Request, ctx: RouteContext): Promise<Response> {
  return handleProxy(req, ctx);
}

export async function HEAD(req: Request, ctx: RouteContext): Promise<Response> {
  return handleProxy(req, ctx);
}
