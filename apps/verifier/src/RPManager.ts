import { ES256, digest } from '@sd-jwt/crypto-nodejs';
import {
  EcdsaSignature,
  InMemoryRPSessionManager,
  JWK,
  JWTPayload,
  PassBy,
  PresentationVerificationCallback,
  PresentationVerificationResult,
  RP,
  ResponseIss,
  ResponseMode,
  ResponseType,
  RevocationVerification,
  Scope,
  SigningAlgo,
  SubjectType,
  SupportedVersion,
} from '@sphereon/did-auth-siop';
import { JWkResolver, encodeDidJWK } from './did.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VerifierRP } from './types.js';
import { SDJwtVcInstance } from '@sd-jwt/sd-jwt-vc';
import { KbVerifier, Verifier } from '@sd-jwt/types';
import { PresentationSubmission } from '@sphereon/pex-models';
import { W3CVerifiablePresentation, CompactJWT } from '@sphereon/ssi-types';
import { importJWK, jwtVerify } from 'jose';
import { getKeys, getPublicKey } from './keys.js';
import { EventEmitter } from 'node:events';
import { RPInstance } from './types.js';

// load the keys
const { privateKey, publicKey } = await getKeys();

export const did = encodeDidJWK(publicKey as JWK);
export const kid = did;

//TODO: when do we need this?
// create the event emitter to listen to events.
export const eventEmitter = new EventEmitter();
//TODO: implement a persistant session manager so reloads don't lose state
export const sessionManager = new InMemoryRPSessionManager(eventEmitter);

/**
 * The RPManager is responsible for managing the relying parties.
 */
export class RPManager {
  // map to store the relying parties
  private rp: Map<string, RPInstance> = new Map();

  /**
   * Get or create the relying party.
   * @param id
   * @returns
   */
  getOrCreate(id: string) {
    let rp = this.rp.get(id);
    if (!rp) {
      rp = this.buildRP(id);
      this.rp.set(id, rp);
    }
    return rp;
  }

  private buildRP(id: string) {
    // create the relying party
    const verifierFile = readFileSync(join('templates', `${id}.json`), 'utf-8');
    if (!verifierFile) {
      throw new Error(`The verifier with the id ${id} is not supported.`);
    }
    const verifier = JSON.parse(verifierFile) as VerifierRP;
    const rp = RP.builder()
      .withClientId(verifier.metadata.clientId)
      .withIssuer(ResponseIss.SELF_ISSUED_V2)
      .withSupportedVersions([SupportedVersion.SIOPv2_D12_OID4VP_D18])
      // TODO: we should probably allow some dynamic values here
      .withClientMetadata({
        client_id: verifier.metadata.clientId,
        idTokenSigningAlgValuesSupported: [SigningAlgo.ES256],
        requestObjectSigningAlgValuesSupported: [SigningAlgo.ES256],
        responseTypesSupported: [ResponseType.ID_TOKEN],
        vpFormatsSupported: {
          'vc+sd-jwt': {
            'sd-jwt_alg_values': [SigningAlgo.ES256],
            'kb-jwt_alg_values': [SigningAlgo.ES256],
          },
        },
        scopesSupported: [Scope.OPENID_DIDAUTHN, Scope.OPENID],
        subjectTypesSupported: [SubjectType.PAIRWISE],
        subject_syntax_types_supported: ['did:jwk'],
        passBy: PassBy.VALUE,
        logo_uri: verifier.metadata.logo_uri,
        clientName: verifier.metadata.clientName,
      })
      //right now we are only supporting the jwk method to make it easier.
      .addResolver('jwk', new JWkResolver())
      .withResponseMode(ResponseMode.DIRECT_POST)
      .withResponseType([ResponseType.ID_TOKEN, ResponseType.VP_TOKEN])
      .withScope('openid')
      .withHasher(digest)
      //TODO: right now the verifier sdk only supports did usage
      .withSuppliedSignature(this.getSigner(), did, kid, SigningAlgo.ES256)
      .withRevocationVerification(RevocationVerification.NEVER)
      .withSessionManager(sessionManager)
      .withEventEmitter(eventEmitter)
      .withPresentationDefinition({
        definition: verifier.request,
      })
      .withPresentationVerification(this.getCall(verifier))
      .build();
    return {
      rp,
      verifier,
    };
  }

  getDefinition(id: string) {
    const rp = this.rp.get(id);
    if (!rp) {
      throw new Error(`The verifier with the id ${id} is not supported.`);
    }
    return rp.verifier;
  }

  getCall(verifier: VerifierRP): PresentationVerificationCallback {
    /**
     * The presentation verification callback. This is called when the verifier needs to verify the presentation. The function can only handle sd-jwt-vc credentials.
     * @param args encoded credential.
     * @param presentationSubmission
     * @returns
     */
    return async (
      args: W3CVerifiablePresentation,
      presentationSubmission: PresentationSubmission
    ): Promise<PresentationVerificationResult> => {
      const inputDescriptor = verifier.request.input_descriptors.find(
        (descriptor) =>
          descriptor.id === presentationSubmission.descriptor_map[0].id
      );
      const requiredClaimKeys = inputDescriptor?.constraints.fields?.map(
        (field) => field.path[0].slice(2)
      );
      try {
        // biome-ignore lint/style/useConst: <explanation>
        let sdjwtInstance: SDJwtVcInstance;
        /**
         * The verifier function. This function will verify the signature of the vc.
         * @param data encoded header and payload of the jwt
         * @param signature signature of the jwt
         * @returns true if the signature is valid
         */
        const verifier: Verifier = async (data, signature) => {
          const decodedVC = await sdjwtInstance.decode(`${data}.${signature}`);
          const payload = decodedVC.jwt?.payload as JWTPayload;
          const header = decodedVC.jwt?.header as JWK;
          const publicKey = await getPublicKey(
            payload.iss as string,
            header.kid as string
          );
          const verify = await ES256.getVerifier(publicKey);
          return verify(data, signature);
        };

        /**
         * The kb verifier function. This function will verify the signature for the key binding
         * @param data
         * @param signature
         * @param payload
         * @returns
         */
        const kbVerifier: KbVerifier = async (data, signature, payload) => {
          if (!payload.cnf) {
            throw new Error('No cnf found in the payload');
          }
          const key = await importJWK(payload.cnf.jwk as JWK, 'ES256');
          return jwtVerify(`${data}.${signature}`, key).then(
            () => true,
            () => false
          );
        };

        // initialize the sdjwt instance.
        sdjwtInstance = new SDJwtVcInstance({
          hasher: digest,
          verifier,
          kbVerifier,
        });
        // verify the presentation.
        await sdjwtInstance.verify(args as CompactJWT, requiredClaimKeys, true);
        return Promise.resolve({ verified: true });
      } catch (e) {
        console.error(e);
        return Promise.reject({ verified: false, error: (e as Error).message });
      }
    };
  }

  getSigner() {
    return async (
      data: string | Uint8Array
    ): Promise<string | EcdsaSignature> => {
      //get the signer, we are only supporting ES256 for now
      const signer = await ES256.getSigner(privateKey);
      return signer(data as string);
    };
  }
}