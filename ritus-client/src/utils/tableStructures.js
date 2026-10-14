// The table structures a project's rows can be stored in, and what can be
// converted into what. Project.table_structure holds one of these keys.

import ContentStructure from "./ContentStructure";
import UsuariumStructure from "./UsuariumStructure";
import CantusStructure from "./CantusStructure";
import {
  ContentStructure_conv,
  UsuariumStructure_conv,
  CantusStructure_conv,
} from "../components/ConversionDescription";

export const TABLE_STRUCTURES = {
  content: ContentStructure,
  usuarium: UsuariumStructure,
  cantus: CantusStructure,
};

export const STRUCTURE_LABELS = {
  content: "eCatalogus Structure",
  usuarium: "Usuarium Structure",
  cantus: "Cantus Index",
};

// Structure names as the conversion maps (ConversionDescription.jsx) spell them.
export const STRUCTURE_MAP_NAMES = {
  content: "ContentStructure",
  usuarium: "UsuariumStructure",
  cantus: "CantusStructure",
};

export const CONVERSION_MAPS = {
  content: ContentStructure_conv,
  usuarium: UsuariumStructure_conv,
  cantus: CantusStructure_conv,
};

// Pairs with a real field mapping: content<->usuarium is bidirectional,
// cantus->content is one-way (see the Cantus Index conversion report for
// the unmapped fields).
export const canConvertStructures = (from, to) =>
  (["content", "usuarium"].includes(from) && ["content", "usuarium"].includes(to)) ||
  (from === "cantus" && to === "content");
