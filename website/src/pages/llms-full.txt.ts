import type { APIRoute } from "astro";
import { buildFull } from "../lib/llms";

export const GET: APIRoute = async ({ site }) =>
  new Response(await buildFull(site), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
