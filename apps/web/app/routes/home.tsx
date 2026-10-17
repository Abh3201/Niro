import { nanoid } from "nanoid";
import { redirect } from "react-router";

/** Every visit to the home page starts a new board. */
export function loader() {
  return redirect(`/b/${nanoid()}`);
}
