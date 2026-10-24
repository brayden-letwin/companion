# Local fine-tuning result — 2026-10-24

**The local training run succeeded. The resulting adapter failed mathematical quality review and was not activated in Companion.** This is evidence that the computer can train an adapter, not evidence that the adapter is a better math tutor.

## Actual run

Run `pilot-2` adapted `Qwen/Qwen3.5-2B` on the local NVIDIA GeForce RTX 4070 using BF16 LoRA. It used 24 original synthetic teaching examples and eight held-out questions from different theorem families. Training ran offline after the public base-weight download; no paper text or conversations were uploaded.

| Measurement | Result |
| --- | --- |
| Optimizer steps / epochs | 12 / 1 |
| Trainable / total parameters | 5,455,872 / 2,218,697,536 |
| LoRA rank / alpha | 8 / 16 |
| Batch size / gradient accumulation | 1 / 2 |
| Learning rate / seed | 0.00005 / 3407 |
| Maximum sequence length | 768 tokens |
| Training time, including first-step compilation | 90.5207 seconds |
| Full run, including loading and paired evaluation | 288.125 seconds |
| Mean training loss | 2.325264 |
| Peak PyTorch-allocated GPU memory | 4,852,110,848 bytes (4.52 GiB) |
| Saved adapter weights | 21,851,336 bytes (20.84 MiB) |

Peak PyTorch allocation excludes driver, display and other process memory. Training loss is not a held-out accuracy score. The first attempted run stopped before training because a multimodal processor was used as a text tokenizer; that was fixed for `pilot-2`.

The saved adapter contains 192 finite tensors. All **96 LoRA B tensors are nonzero**, with a combined L2 norm of **0.2549186594**; they are initialized to zero by this LoRA configuration. Together with the optimizer logs, this verifies a real parameter update rather than a renamed base model or prompt preset.

- Base revision: `15852e8c16360a2fea060d615a32b45270f8a8fc`
- Dataset SHA-256: `8e29cd26ca4d398139001f714aa62f16ba7e704c080f9e516c12cdfa17b35cdb`
- Adapter SHA-256: `195ae254a95bdc1e7a4b29b0b465eaf9e117b6ce6f4a69ae3155f4311e80054f`

The adapter and full run logs are saved locally under `training/runs/pilot-2/` and excluded from Git. [requirements-lock.txt](requirements-lock.txt) records the environment. The run used PyTorch 2.14.1+cu130, Transformers 5.17.0, PEFT 0.21.2 and Unsloth 2026.10.8. Native Windows execution used PyTorch attention and reference causal convolution where optional optimized kernels were unavailable.

## Paired mathematical review

[pilot-evaluation.json](pilot-evaluation.json) contains all eight original prompts, reference answers, unedited model outputs, timings, rubric scores and review notes. The adapter was compared with its own unchanged 2B base using the same prompts and greedy decoding. It was not compared with the app's separate 4B inference model.

| Question | After training |
| --- | --- |
| Compactness and maximum attainment | Removed the base model's false boundedness argument, but mostly restated the theorem. |
| Group cancellation | Incorrectly claimed cancellation requires a nonidentity element; every group element, including the identity, is cancellable. |
| Conditioning on a probability-zero event | Correctly noticed division by zero, then confused independence with positive probability and invented an unsupported limiting argument. |
| ODE uniqueness | Correctly rejected continuity as sufficient, but gave an invalid second solution to its chosen differential equation. |
| Convexity and the midpoint chord | Gave the central picture, but changed a non-strict inequality into a strict one in prose, excluding affine equality. |
| Complex roots of minus one | Improved: correctly distinguished the real and complex domains and gave both roots, `i` and `-i`. |
| Replacing “prime” with any positive integer | Incorrectly said the divisibility statement holds for every integer. Counterexample: 6 divides 2×3 but divides neither 2 nor 3. |
| An undefined “positive A” | Invented a linear transformation, vector and basis instead of asking for the missing definition and assumptions. |

An independent assistant reviewer graded every pair; the training agent cross-checked the substantive errors. This was not a human mathematical sign-off. A combined numerical score would hide serious regressions, so no aggregate improvement claim is made. The adapter is **rejected for app use**.

## Limits and next work

Generation was capped at 256 new tokens with thinking disabled. Several outputs visibly stop mid-sentence or mid-formula and were treated as incomplete. The executed revision did not record exact EOS versus length termination; the current script now records token counts and termination metadata for future runs. No missing continuation was assumed correct.

Eight synthetic questions are a small smoke test. Hostile source instructions were not tested. Twenty-four examples and one epoch cannot establish broader mathematical reliability, real-paper reading ability or a user's individual literacy. Editable familiarity belongs in the app's local profile, rather than being inferred from this adapter's weights.

The next training experiment needs a larger, independently checked teaching dataset and a broader held-out evaluation, including proof errors, domain restrictions, missing context and source-instruction probes. The current adapter should remain an experimental artifact.
