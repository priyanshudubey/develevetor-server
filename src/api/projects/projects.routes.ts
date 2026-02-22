import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { checkRateLimit } from "../../middlewares/rateLimit.middleware";
import {
  listGithubRepos,
  createProject,
  getMyProjects,
  deleteProject,
  syncProject,
  getProjectFiles,
  getFileContent,
} from "./projects.controller";

const router = Router();

// All routes require login
router.use(requireAuth);

router.get("/github-repos", listGithubRepos); // Get list from GitHub
router.get("/", getMyProjects); // Get my imported projects
router.post("/", checkRateLimit("project_create"), createProject); // Import a project
router.delete("/:id", deleteProject);
router.post("/:id/sync", syncProject);
router.get("/:id/files", getProjectFiles);
router.get("/:id/file", getFileContent);

export default router;
