import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256 } from "./release-rehearsal";
import { LocalRuntime } from "./rehearsal-runtime";

const periodicStubs: Record<string, string> = {
  "exports/runner": "export async function runOnePendingExportJob(){return false}",
  "exports/queue": "export async function recoverStaleExportJobs(){return {recovered:0,failed:0}}",
  "review/render-coordinator": "export async function coordinateScheduledRenders(){return {slotsBound:0,failures:[]}}",
  "cost/rollup": "export function defaultCostRollupRange(){return {}};export async function rollupProcessingCosts(){return {sourceEventCount:0}}",
  "integrations/facebook-publisher": "export async function publishDueScheduledPosts(){return {postsScanned:0}};export async function recoverStaleScheduledPosts(){return {recovered:0,failed:0}}",
  "integrations/channel-poller": "export async function pollDueChannelImportSources(){return {sourcesPolled:0}}",
  "observability/error-reporting": "export async function captureErrorSafely(){};export async function flushErrorReporting(){};export async function initErrorReporting(){}",
  "retention": "export async function enqueueDueCleanupJobs(){return {enqueued:0}};export async function sweepOrphanedExportedFiles(){return {rowsDeleted:0}};export async function purgeAbandonedUploads(){return {removed:[]}}",
  "transcription/srt-storage": "export async function purgeAbandonedSrts(){return {removed:0,failed:0}}",
};

const handlerStub = `
import {appendFileSync,existsSync} from 'node:fs';
import path from 'node:path';
export const jobHandlers={TRANSCRIBE:async({job})=>{
 const root=process.env.REHEARSAL_CONTROL;
 appendFileSync(path.join(root,'claims.jsonl'),JSON.stringify({jobId:job.id,pid:process.pid,event:'claim',at:Date.now()})+'\\n');
 while(!existsSync(path.join(root,'release-'+job.id)))await new Promise(r=>setTimeout(r,25));
 appendFileSync(path.join(root,'claims.jsonl'),JSON.stringify({jobId:job.id,pid:process.pid,event:'release',at:Date.now()})+'\\n');
 return {metadata:{synthetic:true}};
}};
`;

export async function preparePinnedBuild(repo: string, root: string, runtime: LocalRuntime, databaseUrl: string) {
  const dependencyRoot = realpathSync(path.join(repo, "node_modules"));
  const lockBytes = readFileSync(path.join(root, "package-lock.json"));
  if (sha256(lockBytes) !== sha256(readFileSync(path.join(repo, "package-lock.json")))) throw new Error("Shared dependency lockfile differs.");
  const locked = JSON.parse(lockBytes.toString()).packages;
  const installed = JSON.parse(readFileSync(path.join(dependencyRoot, ".package-lock.json"), "utf8")).packages;
  for (const [name, entry] of Object.entries(installed)) {
    if (locked[name]?.version !== (entry as { version: string }).version) throw new Error("Installed dependency version differs.");
    const actual = JSON.parse(readFileSync(path.join(repo, name, "package.json"), "utf8"));
    if (actual.version !== locked[name].version) throw new Error("Installed package does not match its lock record.");
  }
  symlinkSync(dependencyRoot, path.join(root, "node_modules"), "dir");
  const originalSchema = readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
  const schema = originalSchema.replace(/provider\s*=\s*"prisma-client-js"/, 'provider = "prisma-client-js"\n  output = "../generated-client"')
    .replace(/binaryTargets\s*=\s*\[[^\]]+\]/, 'binaryTargets = ["native"]');
  if (schema === originalSchema) throw new Error("Prisma generator patch did not match.");
  const schemaPath = path.join(root, "prisma/rehearsal.prisma");
  writeFileSync(schemaPath, schema, { flag: "wx", mode: 0o600 });
  const generated = await runtime.run(process.execPath, [path.join(dependencyRoot, "prisma/build/index.js"), "generate", "--schema", schemaPath], { DATABASE_URL: databaseUrl }, 60000, root);
  const output = path.join(root, "rehearsal-build"); mkdirSync(output, { mode: 0o700 });
  const replacements: Record<string, string> = {};
  for (const [relative, contents] of Object.entries(periodicStubs)) replacements[path.join(root, "src/lib", relative + ".ts")] = contents;
  replacements[path.join(root, "src/lib/jobs/handlers/index.ts")] = handlerStub;
  replacements[path.join(root, "src/lib/auth.ts")] = `export async function requireCurrentUser(){return {id:'00000000-0000-4000-8000-000000000001'}};export async function requirePrimaryWorkspacePermission(){return {workspace:{id:'00000000-0000-4000-8000-000000000002'}}}`;
  replacements[path.join(root, "src/lib/project-service.ts")] = `export async function createProjectFromUploadedSourceVideo(){return {id:'fixture'}};export async function createDraftProjectForWorkspace(){return {id:'fixture'}};export async function correctProjectServiceContext(){return {}}`;
  const workerFile = path.join(root, "src/worker/run-jobs.ts");
  const worker = readFileSync(workerFile, "utf8");
  if (!worker.includes("  assertWorkerRuntimeReady();")) throw new Error("Readiness instrumentation did not match.");
  replacements[workerFile] = worker.replace("  assertWorkerRuntimeReady();", "  /* Fixture build: media readiness bypassed; providers and periodic effects are stubbed. */");
  const bridge = path.join(output, "after.ts");
  writeFileSync(bridge, `export const pending:Promise<void>[]=[];export function after(callback:()=>Promise<void>){pending.push(Promise.resolve().then(callback))}`, { mode: 0o600 });
  const webEntry = path.join(output, "web.ts");
  writeFileSync(webEntry, `
import {createServer} from 'node:http';
import {createProjectFromUploadAction} from '../src/app/actions/projects';
import {pending} from './after';
let closed=false;
const server=createServer(async(req,res)=>{
 if(req.url==='/health'){res.end(JSON.stringify({commit:process.env.SERMON_CLIPPER_COMMIT_SHA,fixture:true}));return}
 if(req.url==='/close'){closed=true;res.end('closed');return}
 if(req.url!=='/fixture'||closed){res.statusCode=409;res.end('refused');return}
 const form=new FormData();form.set('name','Synthetic service');form.set('series','');form.set('speaker','');form.set('sourceVideoId','00000000-0000-4000-8000-000000000101');form.set('sermonDate','2026-05-20');form.set('serviceOccurrence','UNMATCHED');
 try{await createProjectFromUploadAction(form)}catch(e){if(e.message!=='fixture redirect')throw e}
 res.end('accepted');
});
server.listen(Number(process.env.REHEARSAL_PORT),'127.0.0.1',()=>console.log('fixture web ready'));
process.on('SIGTERM',()=>{closed=true;server.close(async()=>{await Promise.all(pending);process.exit(0)})});
`, { mode: 0o600 });
  const patches = Object.entries(replacements).map(([file, replacement]) => ({
    file: path.relative(root, file), originalSha256: existsSync(file) ? sha256(readFileSync(file)) : null,
    replacementSha256: sha256(replacement), replacement,
  }));
  const recoveryEntry = path.join(output, "recover.ts");
  writeFileSync(recoveryEntry, `import {prisma} from '@/lib/prisma';import {recoverStaleProcessingJobs} from '@/lib/jobs/queue';(async()=>{try{console.log(JSON.stringify(await recoverStaleProcessingJobs(prisma,['TRANSCRIBE'])))}finally{await prisma.$disconnect()}})().catch(e=>{console.error(e);process.exitCode=1});`, { mode: 0o600 });
  const entries = [workerFile, webEntry, recoveryEntry];
  const bundles = [];
  for (const [index, entry] of entries.entries()) {
    const outfile = path.join(output, ["worker.cjs", "web.cjs", "recover.cjs"][index]);
    await build({
      entryPoints: [entry], outfile, bundle: true, platform: "node", format: "cjs", packages: "external",
      tsconfig: path.join(root, "tsconfig.json"), sourcemap: true,
      plugins: [{ name: "recorded-fixture-boundaries", setup(builder) {
        builder.onResolve({ filter: /^@prisma\/client$/ }, () => ({ path: path.join(root, "generated-client/index.js"), external: true }));
        builder.onResolve({ filter: /^next\/server$/ }, () => ({ path: bridge }));
        builder.onResolve({ filter: /^next\/(cache|navigation)$/ }, args => ({ path: args.path, namespace: "next-fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "next-fixture" }, () => ({ contents: `export function revalidatePath(){};export function redirect(){throw new Error('fixture redirect')}`, loader: "js" }));
        builder.onLoad({ filter: /\.[tj]sx?$/ }, args => replacements[args.path] === undefined ? undefined : ({ contents: replacements[args.path], loader: "ts", resolveDir: path.dirname(args.path) }));
      } }],
    });
    bundles.push({ file: outfile, sha256: sha256(readFileSync(outfile)) });
  }
  const nativeRoot = path.join(root, "native-web"); mkdirSync(nativeRoot, { mode: 0o700 });
  symlinkSync(dependencyRoot, path.join(nativeRoot, "node_modules"), "dir");
  const actionFile = path.join(root, "src/app/actions/projects.ts");
  const actionSource = readFileSync(actionFile, "utf8");
  await build({ entryPoints: [actionFile], outfile: path.join(nativeRoot, "action.cjs"), bundle: true,
    platform: "node", format: "cjs", packages: "external", tsconfig: path.join(root, "tsconfig.json"),
    plugins: [{ name: "native-next-fixture-boundaries", setup(builder) {
      builder.onResolve({ filter: /^@prisma\/client$/ }, () => ({ path: path.join(root, "generated-client/index.js"), external: true }));
      builder.onLoad({ filter: /\.[tj]sx?$/ }, args => {
        if (args.path === actionFile) return { contents: actionSource.replace('"use server";', "/* Invoked directly by the fixture route. */"), loader: "ts", resolveDir: path.dirname(args.path) };
        return replacements[args.path] === undefined ? undefined : { contents: replacements[args.path], loader: "ts", resolveDir: path.dirname(args.path) };
      });
    } }],
  });
  const nativeFiles: Record<string, string> = {
    "package.json": JSON.stringify({ name: "p2-native-web-fixture", private: true }),
    "next.config.mjs": `export default {experimental:{cpus:1},outputFileTracingRoot:${JSON.stringify(root)}};`,
    "app/layout.jsx": `export default function Layout({children}){return <html><body>{children}</body></html>}`,
    "app/[operation]/route.js": `
import {existsSync,writeFileSync} from 'node:fs';import path from 'node:path';
import {createProjectFromUploadAction} from '../../action.cjs';
export const dynamic='force-dynamic';
export async function GET(request,{params}){
 const {operation}=await params;const marker=path.join(process.env.REHEARSAL_CONTROL,'intake-closed');
 if(operation==='health')return Response.json({commit:process.env.SERMON_CLIPPER_COMMIT_SHA,fixture:true,nativeNext:true});
 if(operation==='close'){writeFileSync(marker,'closed');return new Response('closed')}
 if(operation!=='fixture'||existsSync(marker))return new Response('refused',{status:409});
 const form=new FormData();for(const [key,value] of Object.entries({name:'Synthetic service',series:'',speaker:'',sourceVideoId:'00000000-0000-4000-8000-000000000101',sermonDate:'2026-05-20',serviceOccurrence:'UNMATCHED'}))form.set(key,value);
 try{await createProjectFromUploadAction(form)}catch(error){if(!String(error.digest).startsWith('NEXT_REDIRECT;'))throw error}
 return new Response('accepted');
}`,
  };
  for (const [file, contents] of Object.entries(nativeFiles)) { mkdirSync(path.dirname(path.join(nativeRoot, file)), { recursive: true }); writeFileSync(path.join(nativeRoot, file), contents, { mode: 0o600 }); }
  const nativeBuild = await runtime.run(process.execPath, [path.join(dependencyRoot, "next/dist/bin/next"), "build", "--webpack"], { DATABASE_URL: databaseUrl }, 120000, nativeRoot);
  const record = {
    dependencyLockSha256: sha256(lockBytes), installedLockSha256: sha256(readFileSync(path.join(dependencyRoot, ".package-lock.json"))),
    schemaOriginalSha256: sha256(originalSchema), schemaGeneratedSha256: sha256(schema),
    generatedClientSha256: sha256(readFileSync(path.join(root, "generated-client/index.js"))),
    generation: generated.stdout, patches, bundles,
    webEntrySha256: sha256(readFileSync(webEntry)), afterBridgeSha256: sha256(readFileSync(bridge)),
    nativeNext: { build: nativeBuild, actionSha256: sha256(readFileSync(path.join(nativeRoot, "action.cjs"))), fixtureFiles: Object.fromEntries(Object.entries(nativeFiles).map(([name, contents]) => [name, sha256(contents)])),
      limit: "Native Next host and after() with pinned action/runner; auth, project creation and providers are fixture boundaries. Not the complete deployed application image." },
    limits: ["Shared installed dependencies match pinned lock versions; no clean install was performed.", "Generated Prisma engines target this local OS only, not the deployment image.", "Worker readiness and external periodic effects are instrumented.", "Web action and its callback run with a fixture after() bridge and HTTP host, not the Next.js host lifecycle."],
  };
  writeFileSync(path.join(output, "instrumentation.json"), JSON.stringify(record, null, 2), { mode: 0o600 });
  return { worker: bundles[0].file, web: bundles[1].file, recover: bundles[2].file, nativeWeb: nativeRoot, record };
}
