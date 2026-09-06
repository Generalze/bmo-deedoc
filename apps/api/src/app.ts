import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { OGUN_STATE_ID } from "@pics-nigeria/shared";
import { env } from "./env";
import { prisma } from "./prisma";
import { getRealtimeGatewayStatus } from "./realtime/gateway";
import adminRoutes from "./routes/admin";
import agentRoutes from "./routes/agent";
import authRoutes from "./routes/auth";
import candidateRoutes from "./routes/candidate";
import dashboardRoutes from "./routes/dashboard";
import edgeGovernanceRoutes from "./routes/edge-governance";
import electionDayRoutes from "./routes/election-day";
import evidenceRoutes from "./routes/evidence";
import mediaRoutes from "./routes/media";
import notificationRoutes from "./routes/notifications";
import platformRoutes from "./routes/platform";
import preElectionRoutes from "./routes/pre-election";
import voterRoutes from "./routes/voter";

type JsonParseError = Error & {
  status?: number;
  type?: string;
};

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  if (env.TRUST_PROXY_HOPS > 0) {
    app.set("trust proxy", env.TRUST_PROXY_HOPS);
  }

  const allowedOrigins = new Set(
    env.CORS_ALLOWED_ORIGINS.length > 0
      ? env.CORS_ALLOWED_ORIGINS
      : env.NODE_ENV === "production"
        ? []
        : ["http://localhost:3000", "http://127.0.0.1:3000"],
  );

  const loginLimiter = rateLimit({
    windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
    limit: env.AUTH_RATE_LIMIT_MAX,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { message: "Too many authentication attempts. Try again later." },
  });
  const registrationLimiter = rateLimit({
    windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
    limit: env.REGISTRATION_RATE_LIMIT_MAX,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { message: "Too many registration attempts. Try again later." },
  });

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: false,
    }),
  );
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) {
          callback(null, true);
          return;
        }

        if (allowedOrigins.has(origin)) {
          callback(null, true);
          return;
        }

        const error = new Error("CORS origin not allowed.");
        error.name = "CorsError";
        callback(error);
      },
    }),
  );
  app.use(express.json({ limit: env.API_JSON_BODY_LIMIT }));

  /**
   * Liveness. The process is up and can answer.
   *
   * Deliberately cheap and deliberately unconditional: it is what the container
   * healthcheck and the load balancer poll, and a dependency outage must not
   * cause the orchestrator to start killing otherwise healthy processes.
   */
  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  /**
   * Readiness. The process can actually serve requests.
   *
   * /health answers "ok" whether or not the database exists, so a deployment
   * could report healthy while nothing worked. This is what a post-deploy check
   * should look at: it touches the dependencies, reports what it found, and
   * returns 503 when the platform cannot do its job.
   *
   * It is unauthenticated on purpose and says nothing an attacker can use — no
   * versions, no hostnames, no counts beyond whether reference data exists.
   */
  app.get("/readyz", async (_request, response) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = { ok: true };
    } catch {
      checks.database = { ok: false, detail: "unreachable" };
    }

    /**
     * Ogun reference data is a precondition, not an optimisation. Without it a
     * member cannot register — the server derives their constituency chain from
     * the ward — so an instance without it is up but unusable.
     */
    try {
      const wards = await prisma.ward.count({ where: { stateId: OGUN_STATE_ID } });
      checks.referenceData = wards > 0 ? { ok: true } : { ok: false, detail: "no Ogun wards loaded" };
    } catch {
      checks.referenceData = { ok: false, detail: "unreadable" };
    }

    const realtime = getRealtimeGatewayStatus();
    // Degraded realtime is reported, never fatal: REST carries the platform,
    // and refusing readiness would take the whole deployment down for a
    // subsystem that has a documented fallback.
    checks.realtime = { ok: true, detail: realtime.runtimeStatus };

    const ready = Object.values(checks).every((check) => check.ok);
    return response.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      checks,
      // Read by the post-deploy smoke test. Payouts must be disabled on a fresh
      // deployment; enabling them is a deliberate, separate operator action.
      payoutExecutionEnabled: env.PAYOUT_EXECUTION_ENABLED,
    });
  });

  app.use("/auth/login", loginLimiter);
  app.use("/auth/register-voter", registrationLimiter);
  app.use("/auth", authRoutes);
  app.use("/voter", voterRoutes);
  app.use("/platform", platformRoutes);
  app.use("/election-day", electionDayRoutes);
  app.use("/evidence", evidenceRoutes);
  app.use("/pre-election", preElectionRoutes);
  app.use("/dashboard", dashboardRoutes);
  app.use("/governance", edgeGovernanceRoutes);
  // Legacy/transitional identity routes remain until their content dependencies move to target domains.
  app.use("/admin", adminRoutes);
  app.use("/agent", agentRoutes);
  app.use("/candidate", candidateRoutes);
  app.use("/notifications", notificationRoutes);
  app.use("/media", mediaRoutes);

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const jsonParseError = error as JsonParseError;

    if (jsonParseError.name === "CorsError") {
      response.status(403).json({ message: "CORS origin not allowed." });
      return;
    }

    if (jsonParseError.type === "entity.parse.failed" || jsonParseError.status === 400) {
      response.status(400).json({ message: "Invalid JSON payload." });
      return;
    }

    console.error(error);
    response.status(500).json({ message: "Internal server error." });
  });

  return app;
}
