import { index, type RouteConfig, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("b/:boardId", "routes/board.tsx"),
] satisfies RouteConfig;
