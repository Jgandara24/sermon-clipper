import { buildDefaultEditorState, buildInitialEditorState } from "../../src/lib/editor/types";
import { RehearsalPostgres } from "./rehearsal-postgres";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

export async function seedRehearsal(pg: RehearsalPostgres, database: string) {
  const statements = [
    `INSERT INTO users(id,email,updated_at) VALUES ('${id(1)}','rehearsal@example.invalid',CURRENT_TIMESTAMP)`,
    `INSERT INTO workspaces(id,name,owner_id,updated_at) VALUES ('${id(2)}','Synthetic rehearsal','${id(1)}',CURRENT_TIMESTAMP)`,
  ];
  const families = [100, 200].map(base => {
    const edited = base === 200;
    const editor = edited ? buildDefaultEditorState({ sourceVideoId: id(base + 1), startMs: 0, endMs: 3000 }) : buildInitialEditorState({ sourceVideoId: id(base + 1), startMs: 0, endMs: 3000 });
    if (edited) editor.wordEdits.textOverrides = [{ wordId: `${id(base + 4)}:0`, text: "Corrected" }];
    statements.push(
      `INSERT INTO source_videos(id,workspace_id,origin,storage_key,duration_s,updated_at) VALUES ('${id(base + 1)}','${id(2)}','upload','fixture/${id(base + 1)}.bin',3,CURRENT_TIMESTAMP)`,
      `INSERT INTO projects(id,workspace_id,source_video_id,name,status,updated_at) VALUES ('${id(base + 2)}','${id(2)}','${id(base + 1)}','Synthetic service','ready',CURRENT_TIMESTAMP)`,
      `INSERT INTO transcripts(id,source_video_id,language,provider,full_text,updated_at) VALUES ('${id(base + 3)}','${id(base + 1)}','en','fixture','Synthetic caption words.',CURRENT_TIMESTAMP)`,
      `INSERT INTO transcript_segments(id,transcript_id,idx,start_ms,end_ms,text,words,updated_at) VALUES ('${id(base + 4)}','${id(base + 3)}',0,0,3000,'Synthetic caption words.','[{"word":"Synthetic","startMs":0,"endMs":1000},{"word":"caption","startMs":1000,"endMs":2000},{"word":"words.","startMs":2000,"endMs":3000}]',CURRENT_TIMESTAMP)`,
      `INSERT INTO generated_clips(id,workspace_id,project_id,rank,start_ms,end_ms,title,summary,updated_at) VALUES ('${id(base + 5)}','${id(2)}','${id(base + 2)}',1,0,3000,'Synthetic clip','Fixture',CURRENT_TIMESTAMP)`,
      `INSERT INTO clip_edits(clip_id,version,editor_state,saved_by,updated_at) VALUES ('${id(base + 5)}',${editor.version},${literal(JSON.stringify(editor))}::jsonb,${edited ? `'${id(1)}'` : "NULL"},CURRENT_TIMESTAMP)`,
    );
    if (edited) statements.push(
      `INSERT INTO exported_files(id,storage_key,bytes,width,height,checksum,download_expires_at,updated_at) VALUES ('${id(base + 9)}','fixture/export.bin',16,1080,1920,'synthetic-export',NOW()+INTERVAL '1 day',NOW())`,
      `INSERT INTO export_jobs(id,clip_id,workspace_id,state,edit_version,idempotency_key,filename,output_file_id,updated_at) VALUES ('${id(base + 6)}','${id(base + 5)}','${id(2)}','succeeded',${editor.version},'synthetic-export','fixture.bin','${id(base + 9)}',NOW())`,
      `INSERT INTO clip_approvals(workspace_id,clip_id,state,review_token,review_token_expires_at,updated_at) VALUES ('${id(2)}','${id(base + 5)}','approved','synthetic-only',NOW()+INTERVAL '1 day',NOW())`,
      `INSERT INTO clip_reviews(workspace_id,decision,project_id_snapshot,scheduled_post_id_snapshot,clip_id_snapshot,clip_rank,clip_start_ms,clip_end_ms,export_job_id_snapshot,edit_version,checksum) VALUES ('${id(2)}','revise','${id(base + 2)}','${id(base + 8)}','${id(base + 5)}',1,0,3000,'${id(base + 6)}',${editor.version},'synthetic-export')`,
    );
    return { project: id(base + 2), source: id(base + 1), clip: id(base + 5), edited };
  });
  await pg.sql(database, "BEGIN;" + statements.join(";\n") + ";COMMIT;");
  return families;
}

export async function dataSnapshot(pg: RehearsalPostgres, database: string) {
  // Exclude operational execution tables from the durable caption snapshot only.
  const tables = ["users", "workspaces", "source_videos", "projects", "transcripts", "transcript_segments", "generated_clips", "clip_edits", "clip_reviews", "clip_approvals", "export_jobs", "exported_files"];
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    const rows = await pg.sql(database, `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM ${table} t`);
    result[table] = JSON.parse(rows.stdout.trim());
  }
  return result;
}

export async function schemaSnapshot(pg: RehearsalPostgres, database: string) {
  const constraints = (await pg.sql(database, `SELECT COALESCE(jsonb_agg(jsonb_build_object('table',c.relname,'name',con.conname,'definition',pg_get_constraintdef(con.oid)) ORDER BY c.relname,con.conname),'[]') FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`)).stdout.trim();
  const sequences = (await pg.sql(database, "SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY sequencename),'[]') FROM pg_sequences s WHERE schemaname='public'")).stdout.trim();
  const migrations = (await pg.sql(database, "SELECT jsonb_agg(to_jsonb(m) ORDER BY migration_name) FROM _prisma_migrations m")).stdout.trim();
  const tables = JSON.parse((await pg.sql(database, "SELECT jsonb_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public'")).stdout) as string[];
  if (tables.some(table => !/^[a-z_][a-z0-9_]*$/.test(table))) throw new Error("Unexpected fixture table identifier.");
  const counts = (await pg.sql(database, `SELECT jsonb_build_object(${tables.flatMap(table => [`'${table}'`, `(SELECT count(*) FROM "${table}")`]).join(",")})`)).stdout.trim();
  return { constraints: JSON.parse(constraints), sequences: JSON.parse(sequences), migrations: JSON.parse(migrations), counts: JSON.parse(counts) };
}
