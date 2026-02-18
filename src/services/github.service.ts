import { Octokit } from "octokit";

export class GitHubService {
  private octokit: Octokit;

  constructor(accessToken: string) {
    // We instantiate this per request using the User's specific token.
    // This ensures operations are done "as the user", not as the app.
    this.octokit = new Octokit({ auth: accessToken });
  }

  /**
   * 1. Get current file content & SHA
   * We need the SHA (ID) to ensure we are editing the latest version.
   */
  async getFile(owner: string, repo: string, path: string) {
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path,
      });

      // Guard: Ensure it's a file, not a directory
      if (Array.isArray(data) || !("content" in data)) {
        throw new Error("Path is a directory, not a file");
      }

      return {
        // GitHub sends content in Base64; we decode it to readable text
        content: Buffer.from(data.content, "base64").toString("utf-8"),
        sha: data.sha,
      };
    } catch (error: any) {
      console.error("GitHub Service Error (getFile):", error.message);
      throw new Error(`Failed to fetch file: ${path}. Check if it exists.`);
    }
  }

  /**
   * 2. Create a new branch
   * We never push to 'main'. We create a feature branch first.
   */
  async createBranch(
    owner: string,
    repo: string,
    baseBranch: string,
    newBranchName: string,
  ) {
    try {
      // A. Get the SHA (Head) of the base branch (e.g., 'main')
      const { data: refData } = await this.octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${baseBranch}`,
      });

      // B. Create a new reference (branch) pointing to that same SHA
      await this.octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${newBranchName}`,
        sha: refData.object.sha,
      });
    } catch (error: any) {
      if (error.status === 422) {
        throw new Error(`Branch '${newBranchName}' already exists.`);
      }
      throw error;
    }
  }

  /**
   * 3. Commit the file change
   * This performs the actual "Write" operation.
   */
  async updateFile(params: {
    owner: string;
    repo: string;
    path: string;
    branch: string;
    content: string;
    message: string;
    sha: string; // SAFETY LOCK: Fails if file changed since we read it
  }) {
    await this.octokit.rest.repos.createOrUpdateFileContents({
      owner: params.owner,
      repo: params.repo,
      path: params.path,
      message: params.message,
      content: Buffer.from(params.content).toString("base64"), // Must be Base64
      branch: params.branch,
      sha: params.sha,
    });
  }

  /**
   * 4. Open the Pull Request
   */
  async createPullRequest(params: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string; // Your new branch
    base: string; // 'main'
  }) {
    const { data } = await this.octokit.rest.pulls.create({
      owner: params.owner,
      repo: params.repo,
      title: params.title,
      body: params.body,
      head: params.head,
      base: params.base,
    });
    return data.html_url; // Return the link to the new PR
  }
}
