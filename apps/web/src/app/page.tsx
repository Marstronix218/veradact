import { redirect } from "next/navigation";
import { getAuth } from "@/lib/session";

export default async function HomePage() {
  redirect((await getAuth()) ? "/engagements" : "/login");
}
