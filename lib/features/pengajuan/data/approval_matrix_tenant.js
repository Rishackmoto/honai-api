function normalizeBprId(value, fallback = 'ANP') {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized || fallback;
}

function chooseApprovalPolicyTenant(actor = {}, requestedBprId, fallback = 'ANP') {
  const actorBprId = normalizeBprId(actor.bpr_id, fallback);
  const requested = normalizeBprId(requestedBprId, actorBprId);
  const isSuperAdmin = actor.is_super_admin === true || actor.is_super_admin === 1 || actor.is_super_admin === '1';

  if (isSuperAdmin) {
    return { allowed: true, bprId: requested, isSuperAdmin: true };
  }

  if (requested !== actorBprId) {
    return {
      allowed: false,
      bprId: actorBprId,
      isSuperAdmin: false,
      reason: 'CROSS_TENANT_DENIED',
    };
  }

  return { allowed: true, bprId: actorBprId, isSuperAdmin: false };
}

module.exports = { normalizeBprId, chooseApprovalPolicyTenant };
