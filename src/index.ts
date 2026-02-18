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

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(
  cors({
    origin: ["http://localhost:5173"],
    credentials: true,
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
app.get("/", (req: Request, res: Response) => {
  res.json({
    status: "success",
    message: "DevElevator Server is Running 🚀",
  });
});

app.listen(PORT, () => {
  console.log(`⚡️[server]: Server is running at http://localhost:${PORT}`);
});
