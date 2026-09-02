import { Hono } from "hono";
import type { AppEnv } from "@/types/env";
import { v1Api } from "./v1";
import { webApi } from "./web";

export const api = new Hono<AppEnv>().route("/web", webApi).route("/v1", v1Api);
