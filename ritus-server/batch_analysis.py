import os
import re
import json
import pandas as pd
from rapidfuzz import process, fuzz
import logging
from models import db, Content, BatchProcessing
from threading import Thread

# Configure logging
logger = logging.getLogger(__name__)

# --- Utility Functions ---

def tokenize(text):
    if not isinstance(text, str):
        logger.warning(f"Invalid text input for tokenization: {text}")
        return []
    return text.split()

def load_phrases(csv_path):
    if not os.path.exists(csv_path):
        logger.error(f"CSV file not found: {csv_path}")
        raise FileNotFoundError(f"CSV file not found: {csv_path}")
    df = pd.read_csv(csv_path)
    phrases = {row["id"]: str(row["text"]) for _, row in df.iterrows()}
    logger.info(f"Loaded {len(phrases)} phrases from {csv_path}")
    return phrases

def build_phrases_concordance(phrases):
    phrases_conc_by_word = {}
    token_counter = 1
    for phrase_id, text in phrases.items():
        unique_tokens = set(tokenize(text))
        for token in unique_tokens:
            if token not in phrases_conc_by_word:
                phrases_conc_by_word[token] = {
                    "id": token_counter,
                    "word": token,
                    "popularity": 0,
                    "occurrence_in_phrases": []
                }
                token_counter += 1
            phrases_conc_by_word[token]["popularity"] += 1
            phrases_conc_by_word[token]["occurrence_in_phrases"].append({"phrase_id": str(phrase_id)})
    phrases_conc_by_id = {data["id"]: data for data in phrases_conc_by_word.values()}
    logger.info(f"Built phrases concordance with {len(phrases_conc_by_id)} entries")
    return phrases_conc_by_id, phrases_conc_by_word

def build_phrases_tokens(phrases, phrases_conc_by_word):
    phrases_tokens = {}
    for phrase_id, text in phrases.items():
        tokens = []
        for token in tokenize(text):
            if token in phrases_conc_by_word:
                tokens.append(phrases_conc_by_word[token]["id"])
        phrases_tokens[phrase_id] = {"id": str(phrase_id), "tokens_ids": tokens}
    logger.info("Built tokens")
    return phrases_tokens

def build_text_tokens(content_rows, batch_process):
    text_tokens = []
    word_global_counter = 0
    total_rows = len(content_rows)
    batch_process.total_rows = total_rows
    for i, row in enumerate(content_rows):
        try:
            if isinstance(row.data, str):
                content_data = json.loads(row.data)
            else:
                content_data = row.data
        except (json.JSONDecodeError, TypeError) as e:
            logger.error(f"Invalid JSON in Content.data for ID {row.id}: {row.data}, error: {e}")
            continue
        if not isinstance(content_data, dict):
            logger.warning(f"Content.data for ID {row.id} is not a dict: {content_data}")
            continue
        page_name = content_data.get("where_in_ms_from", str(row.id))
        content = content_data.get("formula_text_from_ms", "")
        if not isinstance(content, str):
            logger.warning(f"Content for ID {row.id} is not a string: {content}")
            content = str(content)
        words = tokenize(content)
        for word in words:
            word_global_counter += 1
            text_tokens.append({
                "page_name": str(page_name),
                "original_word": word,
                "word_number": str(word_global_counter),
                "corcordance_id": None,
                "content_data": content_data.copy()  # Deep copy to preserve source fields
            })
        batch_process.processed_rows = i + 1
        batch_process.progress = 5 + min(((i + 1) / total_rows) * 5, 5)  # 5-10%
        db.session.commit()
        logger.info(f"Processed row {row.id}: {len(words)} tokens")
    logger.info(f"Built {len(text_tokens)} tokens")
    return text_tokens

def annotate_text_tokens(text_tokens, phrases_conc_by_word, similarity_threshold=75, batch_process=None):
    choices = list(phrases_conc_by_word.keys())
    if not choices:
        logger.error("No phrases available for annotation")
        raise ValueError("No phrases available for matching")
    total_tokens = len(text_tokens)
    for i, token in enumerate(text_tokens):
        try:
            match = process.extractOne(token["original_word"], choices, scorer=fuzz.ratio, score_cutoff=similarity_threshold)
            if match:
                token["corcordance_id"] = phrases_conc_by_word[match[0]]["id"]
                token["corcordance_similarity"] = match[1]
            else:
                token["corcordance_id"] = None
                token["corcordance_similarity"] = 0
        except Exception as e:
            logger.error(f"Error annotating token '{token['original_word']}': {e}")
            token["corcordance_id"] = None
            token["corcordance_similarity"] = 0
        if batch_process and total_tokens > 0:
            batch_process.progress = 10 + min(((i + 1) / total_tokens) * 5, 5)  # 10-15%
            db.session.commit()
    logger.info("Completed annotating tokens")
    return text_tokens

def refine_text_tokens(text_tokens, phrases_conc_by_word, similarity_threshold=75, batch_process=None):
    refined_tokens = []
    choices = list(phrases_conc_by_word.keys())
    if not choices:
        logger.error("No phrases available for refinement")
        raise ValueError("No phrases available for refinement")
    word_global_counter = 0
    total_tokens = len(text_tokens)
    i = 0
    while i < len(text_tokens):
        token = text_tokens[i]
        current_word = token["original_word"]
        current_similarity = token["corcordance_similarity"]
        content_data = token["content_data"]
        if i < len(text_tokens) - 1:
            next_token = text_tokens[i + 1]
            combined_word = current_word + next_token["original_word"]
            try:
                combined_match = process.extractOne(combined_word, choices, scorer=fuzz.ratio, score_cutoff=80)
                combined_similarity = combined_match[1] if combined_match else 0
                if combined_similarity > max(current_similarity, next_token["corcordance_similarity"]) and combined_similarity > 80:
                    word_global_counter += 1
                    refined_tokens.append({
                        "page_name": token["page_name"],
                        "original_word": combined_word,
                        "word_number": str(word_global_counter),
                        "corcordance_id": phrases_conc_by_word[combined_match[0]]["id"] if combined_match else None,
                        "corcordance_similarity": combined_similarity,
                        "content_data": content_data.copy()  # Preserve source fields
                    })
                    logger.info(f"Merged: {current_word} ({current_similarity}) + {next_token['original_word']} -> {combined_word} ({combined_similarity})")
                    i += 2
                    continue
            except Exception as e:
                logger.error(f"Error refining token pair '{combined_word}': {e}")
        word_global_counter += 1
        token["word_number"] = str(word_global_counter)
        refined_tokens.append(token)
        if batch_process and total_tokens > 0:
            batch_process.progress = 15 + min(((i + 1) / total_tokens) * 5, 5)  # 15-20%
            db.session.commit()
        i += 1
    logger.info(f"Refined {len(refined_tokens)} tokens")
    return refined_tokens

def length_adjusted_partial_ratio(s1, s2, score_cutoff):
    if not s1 or not s2 or len(s1) * 1.5 < len(s2):
        return 0
    try:
        alignment = fuzz.partial_ratio_alignment(s1, s2, score_cutoff=score_cutoff)
        if not alignment:
            return 0
        start = alignment.src_start
        end = alignment.src_end
        matched_length = end - start
        best_match_length = len(s2)
        length_factor = min(best_match_length / matched_length, matched_length / best_match_length)
        real_score = alignment.score * length_factor
        return real_score
    except Exception as e:
        logger.error(f"Error in length_adjusted_partial_ratio for '{s1[:40]}...': {e}")
        return 0

def cut_text_on_space(text):
    if not text:
        return "", ""
    mid = len(text) // 2
    cut_index = text.rfind(" ", 0, mid + 1)
    if cut_index == -1:
        cut_index = mid
    return text[:cut_index], text[cut_index:]

def smart_append_unfound_result(original_text, results, content_data):
    if not original_text:
        return
    if results and results[-1]["original_text"] == "" and results[-1].get("rite_name_from_ms", "") == "":
        results[-1]["original_text"] += " " + original_text
        results[-1]["content_data"] = content_data.copy()  # Preserve source fields
        results[-1]["check_again"] = "1"
    else:
        results.append({
            "original_text": original_text,
            "best_phrase_id": "",
            "best_phrase_text": "",
            "similarity_percentage": 0,
            "content_data": content_data.copy(),  # Preserve source fields
            "check_again": "1"
        })

def clean_string(string):
    if not isinstance(string, str):
        return ""
    return re.sub(r"\W+", "", string)

def reassign_data(results, text_tokens):
    logger.info(f"Reassigning data for {len(results)} items")
    r = 0
    w = 0
    while r < len(results) and w < len(text_tokens):
        result = results[r]
        original_text = result["original_text"]
        original_text_words = re.sub(r"\W+", " ", original_text).strip().split()
        word = text_tokens[w]
        content_data = word["content_data"].copy()  # Use source content_data
        content_data["where_in_ms_from"] = word["page_name"]
        content_data["where_in_ms_to"] = word["page_name"]
        o = 0
        while o < len(original_text_words):
            w += 1
            o += 1
            if w >= len(text_tokens):
                break
            word = text_tokens[w]
            while w < len(text_tokens) - 1 and clean_string(word["original_word"]) == "":
                w += 1
                word = text_tokens[w]
            while o < len(original_text_words) and clean_string(original_text_words[o]) == "":
                o += 1
            if o < len(original_text_words) and clean_string(word["original_word"]) == clean_string(original_text_words[o]):
                content_data["where_in_ms_to"] = word["page_name"]
            elif o + 1 < len(original_text_words) and clean_string(word["original_word"]) == clean_string(original_text_words[o + 1]):
                o += 1
            elif o < len(original_text_words) and w + 1 < len(text_tokens) and clean_string(text_tokens[w + 1]["original_word"]) == clean_string(original_text_words[o]):
                w += 1
        results[r]["content_data"] = content_data
        r += 1
    return results

def search_phrases_in_text_by_fragment(text_tokens, phrases, similarity_threshold=80, batch_process=None):
    FRAGMENT_LEN = 5674
    words = text_tokens
    choices = {k: v for k, v in phrases.items()}
    if not choices:
        logger.error("No phrases available for search")
        raise ValueError("No phrases available for matching")
    results = []
    text_fragment = ""
    total_words = len(words)
    w = 0
    while w < len(words):
        content_data = words[w]["content_data"].copy()  # Preserve source fields
        while w < len(words) and len(text_fragment) < FRAGMENT_LEN:
            text_fragment += (" " if text_fragment else "") + words[w]["original_word"]
            w += 1
        try:
            match = process.extractOne(text_fragment, choices, scorer=length_adjusted_partial_ratio, score_cutoff=similarity_threshold)
            if match:
                best_phrase_text = match[0]
                best_phrase_id = str(match[2])  # Ensure string
                found = fuzz.partial_ratio_alignment(text_fragment, best_phrase_text)
                start = found.src_start
                end = found.src_end
                before = text_fragment[:start]
                match_text = text_fragment[start:end]
                after = text_fragment[end:]
                content_data["where_in_ms_from"] = content_data.get("where_in_ms_from", words[w-1]["page_name"] if w > 0 else "")
                content_data["where_in_ms_to"] = content_data.get("where_in_ms_to", words[w-1]["page_name"] if w > 0 else "")
                if before:
                    smart_append_unfound_result(before, results, content_data.copy())
                if match_text:
                    content_data["formula_text_from_ms"] = match_text
                    result = {
                        "original_text": match_text,
                        "best_phrase_id": best_phrase_id,
                        "best_phrase_text": best_phrase_text,
                        "similarity_percentage": match[1],
                        "content_data": content_data.copy(),  # Preserve source fields
                        "check_again": "0"
                    }
                    results.append(result)
                text_fragment = after
            else:
                part1, part2 = cut_text_on_space(text_fragment)
                smart_append_unfound_result(part1, results, content_data.copy())
                text_fragment = part2
                logger.info(f"No match for fragment: {part1[:50]}...")
        except Exception as e:
            logger.error(f"Error processing fragment '{text_fragment[:50]}...': {e}")
            part1, part2 = cut_text_on_space(text_fragment)
            smart_append_unfound_result(part1, results, content_data.copy())
            text_fragment = part2
        if batch_process and total_words > 0:
            batch_process.progress = 20 + min((w / total_words) * 10, 10)  # 20-30%
            batch_process.processed_rows = len(results)
            db.session.commit()
    if text_fragment:
        smart_append_unfound_result(text_fragment, results, content_data.copy())
    if batch_process:
        batch_process.progress = 80
        batch_process.processed_rows = len(results)
        db.session.commit()
    logger.info(f"Content search completed with {len(results)} rows")
    return results

def research_unfound_phrases(results, phrases, similarity_threshold=50, batch_process=None, is_rite=False, progress_min=0, progress_max=100):
    total_results = len(results)
    choices = {k: v for k, v in phrases.items()}
    if not choices:
        logger.error("No phrases available for research")
        return results
    updated_results = []
    for i, result in enumerate(results):
        content_data = result["content_data"].copy()  # Preserve source fields
        if result.get("best_phrase_id") != "":
            updated_results.append(result)
            continue
        if result.get("check_again", "0") != "1":
            content_data["similarity_percentage"] = "0"
            result["content_data"] = content_data
            result["similarity_percentage"] = 0
            updated_results.append(result)
            continue
        text = result["original_text"]
        try:
            match = process.extractOne(text, choices, scorer=length_adjusted_partial_ratio, score_cutoff=similarity_threshold)
            if match:
                best_phrase_text = match[0]
                best_phrase_id = str(match[2])  # Ensure string
                found = fuzz.partial_ratio_alignment(text, best_phrase_text)
                start = found.src_start
                end = found.src_end
                before = text[:start]
                match_text = text[start:end]
                after = text[end:]
                if before:
                    smart_append_unfound_result(before, updated_results, content_data.copy())
                if match_text:
                    if is_rite:
                        content_data["rite_name_from_ms"] = match_text
                        content_data["similarity"] = str(match[1])
                        updated_results.append({
                            "original_text": "",
                            "best_phrase_id": "",
                            "best_phrase_text": "",
                            "rite_id": best_phrase_id,
                            "rite_name_from_ms": match_text,
                            "similarity_percentage": match[1],
                            "content_data": content_data.copy(),  # Preserve source fields
                            "check_again": "0"
                        })
                    else:
                        content_data["formula_text_from_ms"] = match_text
                        content_data["similarity"] = str(match[1])
                        updated_results.append({
                            "original_text": match_text,
                            "best_phrase_id": best_phrase_id,
                            "best_phrase_text": best_phrase_text,
                            "similarity_percentage": match[1],
                            "content_data": content_data.copy(),  # Preserve source fields
                            "check_again": "0"
                        })
                if after:
                    smart_append_unfound_result(after, updated_results, content_data.copy())
            else:
                content_data["similarity_percentage"] = "0"
                result["content_data"] = content_data
                result["check_again"] = "0"
                result["similarity_percentage"] = 0
                updated_results.append(result)
                logger.info(f"No match found for unfound: {text[:40]}...")
        except Exception as e:
            logger.error(f"Error processing unfound '{text[:40]}...': {e}")
            content_data["similarity_percentage"] = "0"
            result["content_data"] = content_data
            result["check_again"] = "0"
            result["similarity_percentage"] = 0
            updated_results.append(result)
        if batch_process and total_results > 0:
            batch_process.progress = min(progress_min+ ((i + 1) / total_results) * (progress_max-progress_min), progress_max)  # 80-90%
            batch_process.processed_rows = len(updated_results)
            db.session.commit()
    logger.info(f"Processed {len(updated_results)} entries")
    return updated_results

# --- Main Processing Function ---

def batch_process_project(project_id, similarity_threshold, phrases_csv="static/data/formulas.csv", phrases2_csv="static/data/rite_names.csv"):

    logger.info(f"STARTING Full Automatic Lookup and Split : Bath Process with similarity_threshold: {similarity_threshold}")

    batch_process = db.session.query(BatchProcessing).filter_by(project_id=project_id).first()
    if not batch_process or batch_process.status != "running":
        return None

    try:
        # Load phrases
        formula_phrases = load_phrases(phrases_csv)
        phrases_conc_by_id, phrases_conc_by_word = build_phrases_concordance(formula_phrases)
        phrases_tokens = build_phrases_tokens(formula_phrases, phrases_conc_by_word)
        batch_process.progress = 2.5
        db.session.commit()

        rite_phrases = load_phrases(phrases2_csv)
        batch_process.progress = 5  # After 12 formula passes (12 * 6.67 = 80.04) + initialization
        db.session.commit()

        # Load content rows
        content_rows = db.session.query(Content).filter_by(project_id=project_id).all()
        if not content_rows:
            logger.warning(f"No content rows for project {project_id}")
            batch_process.status = "completed"
            batch_process.progress = 100
            db.session.commit()
            return None

        # Build text tokens
        text_tokens = build_text_tokens(content_rows, batch_process)#5-10%
        if not text_tokens:
            logger.warning(f"No text tokens for {project_id}")
            batch_process.status = "completed"
            batch_process.progress = 100
            db.session.commit()
            return None

        # Annotate and refine tokens
        text_tokens = annotate_text_tokens(text_tokens, phrases_conc_by_word, similarity_threshold, batch_process=batch_process)#10-15%
        text_tokens_refined = refine_text_tokens(text_tokens, phrases_conc_by_word, similarity_threshold, batch_process=batch_process)#15%-20%

        # Search phrases
        logger.info("Searching phrases...")
        results = search_phrases_in_text_by_fragment(text_tokens_refined, formula_phrases, similarity_threshold, batch_process=batch_process)#20-30%

        # Iterative refinement for formulas
        new_results = []
        changes = len(results)
        passes_cntr = 0
        max_passes = 13
        while changes > 0:
            if batch_process.status != "running":
                logger.info(f"Batch process cancelled for project {project_id}")
                return None
            logger.info(f"Pass {passes_cntr}/{max_passes}, detected {changes} items")
            new_results = research_unfound_phrases(results, formula_phrases, similarity_threshold, batch_process=batch_process, is_rite=False, progress_min=30+((passes_cntr+1)/(max_passes+2))*40,progress_max=30+((passes_cntr+2)/(max_passes+2))*40 )#30%-70%
            passes_cntr += 1
            changes = len(new_results) - len(results)
            results = new_results.copy()

        #Setting all unfound rows to check_again:
        for i, result in enumerate(results):
            if batch_process.status != "running":
                logger.info(f"Batch process cancelled for {project_id}")
                return None
            if result["best_phrase_id"] == "":
                result["check_again"] = "1"

        # Iterative refinement for rites
        """
        new_results = []
        changes = len(results)
        passes_cntr = 0
        max_passes = 5
        while changes > 0:
            if batch_process.status != "running":
                logger.info(f"Batch process cancelled for project {project_id}")
                return None
            logger.info(f"Pass {passes_cntr}/{max_passes}, detected {changes} items")
            new_results = research_unfound_phrases(results, rite_phrases, similarity_threshold, batch_process=batch_process, is_rite=True, progress_min=70+((passes_cntr+1)/(max_passes+2))*20,progress_max=70+((passes_cntr+2)/(max_passes+2))*20 )#70%-90%
            passes_cntr += 1
            changes = len(new_results) - len(results)
            results = new_results.copy()
        """

        # Reassign data
        results = reassign_data(results, text_tokens_refined)
        batch_process.progress = 90
        db.session.commit()

        # Clear existing content
        db.session.query(Content).filter_by(project_id=project_id).delete()
        db.session.commit()

        # Save results to Content
        total_rows = len(results)
        for i, result in enumerate(results):
            if batch_process.status != "running":
                logger.info(f"Batch process cancelled for {project_id}")
                return None
            content_data = result["content_data"].copy()  # Preserve source fields
            logger.info("PRE:")
            logger.info(json.dumps(content_data))
            content_data["formula_text_from_ms"] = result["original_text"]
            content_data["sequence_in_ms"] = i + 1
            content_data["formula_id"] = result.get("best_phrase_id", "")
            content_data["rite_name_from_ms"] = result.get("rite_name_from_ms", "")
            content_data["rite_id"] = result.get("rite_id", "")
            logger.info("POST:")
            logger.info(json.dumps(content_data))
            content = Content(project_id=project_id, data=json.dumps(content_data))
            db.session.add(content)
            batch_process.processed_rows = i + 1
            batch_process.progress = 90 + min((i + 1) / total_rows * 10, 10) if total_rows > 0 else 100
            db.session.commit()

        batch_process.status = "completed"
        batch_process.progress = 100.0
        db.session.commit()
        logger.info(f"Batch process completed for project {project_id}")

    except Exception as e:
        batch_process.status = "failed"
        batch_process.error_message = str(e)
        db.session.commit()
        logger.error(f"Batch process failed for project {project_id}: {e}")
        raise