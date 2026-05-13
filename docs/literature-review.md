# Literature Review: KG + Tool-Calling LLM for Clinical QA over EHRs

## 1. Clinical QA over EHRs

- **emrQA** (Pampari et al., EMNLP 2018) — 1M+ QA pairs generated via template slot-filling from n2c2 annotations over discharge notes; still the most-cited EHR QA benchmark, but logical-form-driven and note-centric rather than structured. *Baseline to cite; our work is structured-data first.*
- **EHRSQL** (Lee et al., NeurIPS D&B 2022) — 24.4K text-to-SQL pairs over MIMIC-III and eICU collected from 222 hospital staff; introduces unanswerable questions and F1_exe. *Our SQL+FTS baseline should use this methodology.*
- **EHRNoteQA** (Kweon et al., NeurIPS D&B 2024) — 962 patient-specific questions over MIMIC-IV discharge notes; designed for LLM evaluation. *Closest recent LLM-era EHR QA benchmark.*
- **EHRXQA** (Bae et al., NeurIPS D&B 2023) — multi-modal (tables + chest X-ray) QA over MIMIC-IV/MIMIC-CXR. *Shows the field's shift toward agentic multi-source retrieval.*
- **MIMIC-IV-Ext-Instr** (PhysioNet, 2025) — 450K+ EHR-grounded instruction pairs for fine-tuning. *Relevant if we fine-tune.*

**Synthea usage**: Soni et al. (2019) built the earliest FHIR-QA set from Synthea; Kothari & Gupta (2025) generated Synthea QA pairs for fine-tuning. Synthea is common for pipelines but **rare as a formal benchmark** — most published benchmarks use MIMIC.

## 2. Knowledge Graphs for Clinical/Biomedical QA

- **PrimeKG** (Chandak, Huang & Zitnik, Nature Scientific Data 2023) — 17K diseases, 4M edges integrating 20 resources; *general medical knowledge, not per-patient*.
- **SPOKE** (Morris et al., Bioinformatics 2023) — heterogeneous biomedical KG; *also disease-/concept-level, not patient-level*.
- **GraphCare** (Jiang et al., ICLR 2024) — personalized KGs per patient distilled from LLMs + external KGs for clinical prediction; *closest "per-patient graph" precedent, but for prediction not QA*.
- **EHR-KG system** (Gong et al., JMIR 2024, "EHR-Oriented KG System for Collaborative CDS") — multi-center fragmented EHR integration via KG. *Patient-data KG precedent.*
- **Patient-Centric KGs: Survey** (Chandak et al., Frontiers in AI 2024) — confirms the gap: most clinical KG work is concept-level (UMLS/PrimeKG), patient-level KGs are emerging but under-explored.

## 3. Text-to-Cypher / Text-to-SQL for Healthcare

- **Text2Cypher** (Ozsoy et al., arXiv 2412.10064, 2024) — general Text2Cypher benchmark; no clinical focus.
- **Ozsoy et al., "Real-Time Text-to-Cypher"** (Future Internet, MDPI 2024) — LLM Cypher generation pipelines.
- **medIKAL** (Yuan et al., arXiv 2406.14326, 2024) — integrates medical KGs as LLM assistants for EMR-based diagnosis; retrieval over KG, not Cypher generation.
- **Hybrid Graph RAG for patient QA** (arXiv 2602.00009, 2025) — Text2Cypher + embeddings pipeline for patient-level EHR KG; claims "no existing system integrates graph DB + Text2Cypher + vectors for patient-level EHR." *This is our closest methodological neighbor.*

Patient-level Text2Cypher on EHRs remains thinly explored; most clinical text-to-query work targets SQL.

## 4. GraphRAG & Tool-Calling Agents for Medical QA (closest neighbor)

- **EHRAgent** (Shi et al., EMNLP 2024) — code-generating LLM agent over MIMIC-III/eICU/TREQS; +19.9% over baselines. **Tool-calling but targets SQL, not KG.**
- **MedAgentBench** (Jiang et al., NEJM AI 2025) — 300 tasks, 100 patients, FHIR-compliant interactive env for medical LLM agents. *Our most relevant evaluation harness.*
- **FHIR-AgentBench** (arXiv 2509.19319, 2025) — 2,931 QA pairs over MIMIC-IV-FHIR; five agent architectures (FHIR query gen, retriever, retriever+code, ReAct variants). Best agent hits only 50% correctness. **No KG — uses FHIR API retrieval directly. This is our single closest competitor.**
- **MedRAG / self-correcting Agentic GraphRAG for hepatology** (PMC 2025) — diagnostic KG built from EHRs, subgraph retrieval per patient.
- **Medical-Graph-RAG** (ACL 2025, ImprintLab) — evidence-based medical GraphRAG.
- **KGARevion** (Su et al., arXiv 2410.04660, 2024) — KG-based agent that verifies LLM-generated triplets; concept-KG, not patient-KG.
- **MedSumGraph** (ScienceDirect 2025) — GraphRAG with summarization for medical QA.
- **Microsoft GraphRAG** (Edge et al., 2024) — general-purpose, not clinical, but the methodological anchor for community-summary GraphRAG.

## 5. LLM-Only Clinical QA Baselines

- **Med-PaLM 2** (Singhal et al., Nature Medicine 2024) — 86.5% MedQA (USMLE); expert-preferred answers on 8/9 clinical axes.
- **GPT-4 / GPT-4-base on MedQA** (Nori et al., 2023) — 86.1% (base). GPT-3.5: 60.2%. These numbers are for **exam-style multiple-choice**, not EHR-grounded QA.
- On EHR-grounded QA (EHRNoteQA, EHRSQL), **pure LLMs underperform dramatically** — FHIR-AgentBench shows SOTA agents cap at ~50% answer correctness. The gap between exam QA and patient-data QA is the key motivation for our work.

## 6. Evaluation Methodology

Standard practice across emrQA, EHRSQL, EHRNoteQA, FHIR-AgentBench, MedAgentBench:
- **Question categories**: retrieval vs aggregation vs temporal vs cohort/comparative; answerable vs unanswerable.
- **Metrics**: execution accuracy (F1_exe), answer correctness (LLM-judge or exact match), retrieval precision/recall, unanswerable-detection.
- **Statistics**: bootstrap CIs, McNemar's test for paired system comparisons, inter-annotator agreement (Cohen's kappa) for expert-rated correctness.
- **Multi-system comparison**: typically LLM-only vs RAG vs tool-calling vs fine-tuned, stratified by difficulty tier.

---

## Novelty Assessment

- **Shared-concept patient KG schema** (per-patient instances linking to shared diagnosis/med/lab concept nodes) is **uncommon** — GraphCare builds per-patient KGs but for prediction; EHR-KG systems integrate data but don't publish this exact denormalized schema. *Mild novelty.*
- **MCP-tool-calling over a Kuzu KG for clinical QA** appears novel. Published work uses either (a) SQL agents (EHRAgent), (b) FHIR API agents (FHIR-AgentBench), or (c) hand-written retrievers over KGs (MedRAG). **No published system uses MCP + embedded KG + tool-calling on a Synthea-scale cohort.**
- **Multi-baseline head-to-head (KG+tools vs SQL vs SQL+FTS vs LLM-only)** on the same synthetic cohort is rare — most papers compare against 1-2 baselines. *Methodological contribution.*
- **Scaling claim (KG advantage grows with population size)** is untested in the literature — EHRAgent and FHIR-AgentBench don't study population-size scaling. *Genuinely novel if demonstrated empirically.*
- **Synthea-based** open benchmark: most work uses MIMIC (restricted). A reproducible Synthea-based QA benchmark is a real contribution, though Soni 2019 and Kothari 2025 have priors.

**Honest caveat**: the core idea (LLM agent + graph DB + EHR QA) is 2024-2025 territory and crowded. Novelty lives in the *schema*, the *MCP tool granularity*, the *scaling study*, and the *4-way baseline comparison* — not in the high-level architecture.

## Suggested Venues

- **AMIA Annual Symposium / AMIA Informatics Summit** — natural home for EHR-KG systems.
- **JAMIA (Journal of the American Medical Informatics Association)** — target journal for the full system paper.
- **NeurIPS Datasets & Benchmarks Track** — if we release the Synthea QA benchmark (precedent: EHRSQL, EHRNoteQA, EHRXQA).
- **ML4H (Machine Learning for Health, PMLR)** — good fit for the scaling study.
- **ACL ClinicalNLP Workshop / Findings of ACL or EMNLP** — for the tool-calling/agent methodology.
- **NEJM AI** — increasingly publishing LLM-agent benchmarks (MedAgentBench precedent).

## Closest Competitor

**FHIR-AgentBench** (arXiv:2509.19319, 2025) — 2,931 clinician-authored QA pairs over MIMIC-IV-FHIR, evaluating 5 agent architectures including multi-turn ReAct with code tools. Best system: ~50% correctness.

**What differentiates ours:**
1. They use **FHIR API retrieval**, we use a **pre-built Kuzu KG with shared-concept schema** — enables cohort and cross-patient queries that FHIR API alone struggles with.
2. They benchmark agents on MIMIC-IV; we benchmark on **Synthea at controllable population scale** (2,264 → N) to study scaling behavior.
3. They compare agent architectures; we compare **paradigms** (KG+tools vs SQL vs LLM-only), giving a cleaner answer to "is the KG worth it?"
4. Our **MCP tool layer** (search_patients, find_cohort, get_temporal_relation, etc.) is a higher-level abstraction than their raw FHIR query generation.

Runner-up competitor: **EHRAgent** (EMNLP 2024) — same tool-calling philosophy but SQL-based and no KG.
