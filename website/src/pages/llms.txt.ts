import type { APIRoute } from "astro";
import { buildIndex } from "../lib/llms";

export const GET: APIRoute = async ({ site }) =>
  new Response(await buildIndex(site), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
