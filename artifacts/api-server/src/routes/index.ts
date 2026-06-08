import { Router, type IRouter } from "express";
import healthRouter from "./health";
import biRouter from "./bi";

const router: IRouter = Router();

router.use(healthRouter);
router.use(biRouter);

export default router;
