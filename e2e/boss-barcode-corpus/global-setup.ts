import { seedLocalCorpusTenant } from "./admin";
export default async function globalSetup() { await seedLocalCorpusTenant(); }
