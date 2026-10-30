import { index, type RouteConfig, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("b/:boardId", "routes/board.tsx"),
  route("boards", "routes/boards.tsx"),
  route("signin", "routes/signin.tsx"),
  route("api/token", "routes/api.token.ts"),
  route("api/board", "routes/api.board.ts"),
  route("api/auth/*", "routes/api.auth.ts"),
] satisfies RouteConfig;
