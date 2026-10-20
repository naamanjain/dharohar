/**
 * Officer provisioning and district registry endpoints (design defaults D2 and D4).
 *
 * Every route here requires the USER_ADMIN capability, which no role implies and no registration
 * flow can obtain: the first holder is created by `npm run db:bootstrap-admin` at the shell, and
 * further administrators are created by one that already exists. There is no public self-signup
 * anywhere in this application.
 *
 * The registry routes exist because migration 0003 made `districts` a real authority: filing under a
 * district that is not declared is refused by the database. Refusing without a way to declare would
 * be an outage, so declaring one is capability-gated, validated, and written to the same audit chain.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authenticateToken } from '../middleware/auth';
import { ProvisioningRejected, createOfficer, listOfficers, resetOfficerPassword, setOfficerCapabilities, setOfficerJurisdictions, setOfficerRole } from '../services/provisioning';
import { RegistryRejected, declareDistrict, listDistricts, promoteDistrict, setDistrictActive } from '../services/districtRegistry';
import { districtRefusal, mayProvisionOfficers } from '../services/jurisdiction';

export const adminRouter = Router();

function respondFailure(res: Response, err: any) {
  if (err instanceof ProvisioningRejected) {
    const status = err.code === 'OFFICER_NOT_FOUND' ? 404 : err.code === 'OFFICER_EXISTS' ? 409 : 400;
    return res.status(status).json({ success: false, error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof RegistryRejected) {
    if (err.code === 'REGISTRY_REQUIRES_DATABASE') {
      return res.status(503).json({ success: false, error: { code: err.code, message: err.message } });
    }
    const status = err.code === 'DISTRICT_NOT_FOUND' || err.code === 'ORGANIZATION_NOT_FOUND' ? 404 : 400;
    return res.status(status).json({ success: false, error: { code: err.code, message: err.message, details: err.details } });
  }
  const refusal = districtRefusal(err);
  if (refusal) {
    return res.status(400).json({ success: false, error: refusal });
  }
  console.error('[ADMIN] provisioning failed:', err.message);
  return res.status(503).json({
    success: false,
    error: {
      code: 'PROVISIONING_FAILED',
      message: 'The officer change was not recorded. No account, assignment or capability was altered.',
    },
  });
}

/** Capability gate. Kept as middleware so a route added later cannot forget it. */
function requireProvisioningAuthority(req: Request, res: Response, next: NextFunction) {
  if (!req.principal || !mayProvisionOfficers(req.principal)) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'USER_ADMIN_CAPABILITY_REQUIRED',
        message: 'Officer provisioning requires the USER_ADMIN capability. Holding a senior role is not sufficient.',
      },
    });
  }
  next();
}

adminRouter.use(authenticateToken, requireProvisioningAuthority);

// GET /api/admin/officers — roster with live assignments. Never returns password material.
adminRouter.get('/officers', async (req: Request, res: Response) => {
  try {
    const officers = await listOfficers(req.principal!);
    return res.json({ success: true, data: { total: officers.length, officers } });
  } catch (err) {
    return respondFailure(res, err);
  }
});

// POST /api/admin/officers — create an officer with districts and capabilities in one transaction.
adminRouter.post('/officers', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  try {
    const officer = await createOfficer(
      {
        id: body.id,
        email: body.email,
        displayName: body.displayName,
        designation: body.designation,
        badgeNumber: body.badgeNumber,
        role: body.role,
        districts: body.districts,
        capabilities: body.capabilities,
        password: body.password,
        state: body.state,
      },
      req.principal!
    );
    return res.status(201).json({
      success: true,
      data: { officer },
      message: `Officer ${officer.id} provisioned with ${officer.districts.length} jurisdiction assignment(s).`,
    });
  } catch (err) {
    return respondFailure(res, err);
  }
});

// PUT /api/admin/officers/:id/jurisdictions — replace the set, diffed into the audit trail.
adminRouter.put('/officers/:id/jurisdictions', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  try {
    const change = await setOfficerJurisdictions(req.params.id, body.districts ?? [], body.reason, req.principal!);
    return res.json({ success: true, data: change, message: 'Jurisdiction assignments updated.' });
  } catch (err) {
    return respondFailure(res, err);
  }
});

// PUT /api/admin/officers/:id/capabilities — replace the set (STATE_WIDE_READ, USER_ADMIN, PARCEL_REHOME).
adminRouter.put('/officers/:id/capabilities', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  try {
    const change = await setOfficerCapabilities(req.params.id, body.capabilities ?? [], body.reason, req.principal!);
    return res.json({ success: true, data: change, message: 'Capability grants updated.' });
  } catch (err) {
    return respondFailure(res, err);
  }
});

// PATCH /api/admin/officers/:id/role
adminRouter.patch('/officers/:id/role', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  try {
    const change = await setOfficerRole(req.params.id, body.role, body.reason, req.principal!);
    return res.json({ success: true, data: change, message: `Role changed from ${change.before} to ${change.after}.` });
  } catch (err) {
    return respondFailure(res, err);
  }
});

// POST /api/admin/officers/:id/password-reset — the new password is never echoed or audit-logged.
adminRouter.post('/officers/:id/password-reset', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  try {
    await resetOfficerPassword(req.params.id, body.password, body.reason, req.principal!);
    return res.json({
      success: true,
      data: { officerId: req.params.id },
      message: 'Password replaced. The officer must sign in again; any session already issued keeps its token until it expires.',
    });
  } catch (err) {
    return respondFailure(res, err);
  }
});

// GET /api/admin/districts — the registry with the counts an operator needs before retiring one.
adminRouter.get('/districts', async (req: Request, res: Response) => {
  try {
    const districts = await listDistricts(req.principal!);
    return res.json({ success: true, data: { total: districts.length, districts } });
  } catch (err) {
    return respondFailure(res, err);
  }
});

// POST /api/admin/districts — declare a jurisdiction as the department spells it.
// Since migration 0003 nothing can be filed under a district that is not declared, so this is the
// only supported way to widen the registry without touching the database by hand.
adminRouter.post('/districts', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  try {
    const { district, created, granted } = await declareDistrict(
      { name: body.name, organizationId: body.organizationId, relationship: body.relationship },
      req.principal!
    );
    return res.status(created ? 201 : 200).json({
      success: true,
      data: { district },
      message: created
        ? `District "${district.name}" declared as ${district.code}. It is ${district.kind} geography until an administrator promotes it, and ${granted ? 'your organization may now work in it' : 'not yet granted to your organization'}. Records can now be filed under it.`
        : `District "${district.name}" was already registered; nothing changed. Renaming a district is a separate decision from creating one.`,
    });
  } catch (err) {
    return respondFailure(res, err);
  }
});

// POST /api/admin/districts/:code/promote — decide that a candidate district IS canonical geography.
// Migration 0007 stopped a declaration from meaning that by default, so the claim now needs a named
// actor, a written reason and an audit entry. Retired fixtures are refused, not rescued.
adminRouter.post('/districts/:code/promote', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  try {
    const change = await promoteDistrict(req.params.code, body.reason, req.principal!);
    return res.json({
      success: true,
      data: change,
      message: `District ${change.district.code} is now canonical geography, on the record and with the reason written down.`,
    });
  } catch (err) {
    return respondFailure(res, err);
  }
});

// PATCH /api/admin/districts/:code/active — retire or restore a jurisdiction, with a reason.
// Existing records keep their district; only new filing stops.
adminRouter.patch('/districts/:code/active', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  try {
    const change = await setDistrictActive(req.params.code, body.isActive === true, body.reason, req.principal!);
    return res.json({
      success: true,
      data: change,
      message: `District ${change.code} is now ${change.isActive ? 'active' : 'inactive'}. It still holds ${change.records} record(s) and ${change.officers} officer assignment(s), all of which remain reachable.`,
    });
  } catch (err) {
    return respondFailure(res, err);
  }
});
