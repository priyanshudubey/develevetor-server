import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import {
  listGithubRepos,
  createProject,
  getMyProjects,
  deleteProject,
  syncProject,
} from "./projects.controller";

const router = Router();

// All routes require login
router.use(requireAuth);

router.get("/github-repos", listGithubRepos); // Get list from GitHub
router.get("/", getMyProjects); // Get my imported projects
router.post("/", createProject); // Import a project
router.delete("/:id", deleteProject);
router.post("/:id/sync", syncProject);

export default router;
