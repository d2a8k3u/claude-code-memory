export type MemoryType = 'episodic' | 'semantic' | 'procedural' | 'working' | 'pattern';

export type RelationType = 'relates_to' | 'depends_on' | 'contradicts' | 'extends' | 'implements' | 'derived_from';

export type Memory = {
  id: string;
  type: MemoryType;
  title: string | null;
  content: string;
  context: string | null;
  source: string | null;
  tags: string[];
  importance: number;
  created_at: string;
  updated_at: string;
  access_count: number;
  last_accessed: string | null;
  injection_count: number;
};

export type MemoryRow = {
  id: string;
  type: string;
  title: string | null;
  content: string;
  context: string | null;
  source: string | null;
  tags: string; // JSON string
  importance: number;
  created_at: string;
  updated_at: string;
  access_count: number;
  last_accessed: string | null;
  injection_count: number;
  /**
   * Non-null marks this memory as superseded — excluded from search and injection
   * but kept in the database. Holds either the id of the newer memory that replaced
   * it, or a `project:<version>` sentinel when demoted by the project-version
   * staleness pass.
   */
  superseded_by: string | null;
};

export type Relation = {
  source_id: string;
  target_id: string;
  relation_type: RelationType;
  weight: number;
};

export function rowToMemory(row: MemoryRow): Memory {
  return {
    ...row,
    type: row.type as MemoryType,
    tags: JSON.parse(row.tags),
  };
}
