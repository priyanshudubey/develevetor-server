import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser"; // Don't forget this!
import * as dotenv from "dotenv";
import authRoutes from "./api/auth/auth.routes";
import projectsRoutes from "./api/projects/projects.routes";
import ChatRoutes from "./api/chat/chat.routes";
import githubRoutes from "./api/github/github.routes";
import usersRoutes from "./api/users/users.routes";
import dashboardRoutes from "./api/dashboard/dashboard.routes";
import razorpayRoutes from "./api/razorpay/razorpay.routes";
import { logger } from "./config/logger";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;


// Middleware
app.use(
  cors({
    origin: ["http://localhost:5173"],
    credentials: true,
    exposedHeaders: ["x-sources"],
  }),
);
app.use(helmet());
app.use(morgan("dev"));
app.use(cookieParser());
app.use(express.json());

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/projects", projectsRoutes);
app.use("/api/chat", ChatRoutes);
app.use("/api/github", githubRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/razorpay", razorpayRoutes);
app.get("/", (req: Request, res: Response) => {
  res.json({
    status: "success",
    message: "DevElevator Server is Running 🚀",
  });
});

logger.info("🚀 Server booted up! Testing Grafana Loki connection...");

app.listen(PORT, () => {
  logger.info(`⚡️[server]: Server is running at http://localhost:${PORT}`, {
    port: PORT,
  });
});
