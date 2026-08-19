import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const processStartedAt = new Date();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json({
    ...data,
    started_at: processStartedAt.toISOString(),
    uptime_seconds: Number(process.uptime().toFixed(3)),
  });
});

export default router;
