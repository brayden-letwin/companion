# Pilot evaluation

Compare `before.json` and `after.json` without treating the reference wording as the only correct answer. Score each criterion below 0 (wrong/missing), 1 (partly met), or 2 (fully met). The example-specific rubric points clarify the intended judgment.

1. **Mathematical correctness:** claims, calculations, domains and counterexamples are valid.
2. **Source faithfulness:** conclusions follow from supplied evidence; missing definitions are acknowledged.
3. **Teaching usefulness:** explanation connects intuition to the mathematical reason at the stated familiarity.
4. **Calibration:** false premises are corrected; ambiguity causes a focused question; intuition is not presented as proof.

Record an independent judgment, not just a string-match or model self-score. Inspect every mathematical error separately; a higher average cannot compensate for introducing a confidently wrong explanation.

Promotion requires no new correctness failures, no source-instruction following, and a clear teaching improvement on held-out examples. These eight examples are only a smoke test. Before everyday use, add a larger independently reviewed evaluation set from actual intended mathematical domains, with permission to use its source text. Split by paper/theorem family so neighboring passages cannot leak into both training and evaluation.

The trained adapter is a **small teaching-style experiment**. Twenty-four synthetic examples do not establish improved broad reasoning, research-paper accuracy, or learning of a user's mathematical knowledge. Keep personal familiarity in editable local memory, not in model weights.
