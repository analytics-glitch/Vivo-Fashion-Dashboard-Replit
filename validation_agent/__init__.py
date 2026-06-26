"""Self-contained data-validation agent for the Vivo BI retail dataset.

Runs five steps each cycle: consistency checks, learned-range checks, LLM
diagnosis, governance, and alerting. Writes only to its own three tables
(metric_baselines, validation_audit, validation_exceptions). Entry point:
``python3 -m validation_agent.run``.
"""
