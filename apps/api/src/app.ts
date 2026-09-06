import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { env } from "./env";
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

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
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
