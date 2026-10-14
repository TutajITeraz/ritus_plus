// Converting the saved table of a project from one structure to another
// (Advanced... on the project list). Same rules as the Convert dialog in the
// table editor; the table is replaced and Project.table_structure updated.

import { fetchProjectContent, saveProjectContent, updateProject } from "../apiUtils";
import { convertRows } from "./convertRows";
import { sortCantusRows } from "./cantusSequence";
import {
  TABLE_STRUCTURES,
  CONVERSION_MAPS,
  STRUCTURE_MAP_NAMES,
  canConvertStructures,
} from "./tableStructures";

export const structureOf = (project) => project.table_structure || "content";

// Split projects by what converting them to `target` would mean.
export const planTableConversion = (projects, target) => {
  const plan = { convert: [], same: [], unsupported: [] };
  for (const p of projects) {
    const from = structureOf(p);
    if (from === target) plan.same.push(p);
    else if (canConvertStructures(from, target)) plan.convert.push(p);
    else plan.unsupported.push(p);
  }
  return plan;
};

export const convertProjectTable = async (project, target, fetchMappingFile) => {
  const from = structureOf(project);
  const content = await fetchProjectContent(project.id, { silent: true });
  if (content.length > 0) {
    let sourceRows = content.map((row) => ({ ...row.data }));
    if (from === "cantus") sourceRows = sortCantusRows(sourceRows);
    const rows = await convertRows({
      sourceRows,
      conversionMap: CONVERSION_MAPS[from],
      targetStructure: TABLE_STRUCTURES[target],
      targetStructureName: STRUCTURE_MAP_NAMES[target],
      fetchMappingFile,
    });
    await saveProjectContent(
      project.id,
      rows.map(({ _internalId, ...row }) => row),
      { silent: true }
    );
  }
  await updateProject(project.id, { table_structure: target });
};
