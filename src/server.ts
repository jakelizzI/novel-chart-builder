import { deleteProject, getFlowchart, listProjects, saveFlowchart } from "./db";
import indexHtml from "./index.html";
import type { FlowchartData } from "./types";

const PORT = Number(process.env.PORT || 3000);

const server = Bun.serve({
  port: PORT,
  routes: {
    "/": indexHtml,

    "/api/auth/me": {
      GET() {
        return Response.json({
          authenticated: true,
          email: "local@dev",
          authMode: "local",
        });
      },
    },

    "/api/projects": {
      GET() {
        const projects = listProjects();
        return Response.json(projects);
      },
    },

    "/api/flowchart/:id": {
      GET(req) {
        const id = req.params.id;
        const chart = getFlowchart(id);
        if (!chart) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        return Response.json(chart);
      },

      async PUT(req) {
        const id = req.params.id;
        const body = (await req.json()) as FlowchartData;
        const saved = saveFlowchart({
          ...body,
          id: id || body.id || "default",
        });
        return Response.json(saved);
      },

      DELETE(req) {
        const id = req.params.id;
        const ok = deleteProject(id);
        return Response.json({ deleted: ok });
      },
    },
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`🚀 Novel Chart Builder running at http://localhost:${server.port}`);
