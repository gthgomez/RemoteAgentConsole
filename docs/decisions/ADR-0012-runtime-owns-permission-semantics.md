# ADR-0012: The runtime owns permission semantics

Status: Accepted

The host brokers permission requests and sends back the exact selected option exposed by the runtime. The application does not create new choices or silently weaken runtime policy.
