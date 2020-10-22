import {
  CollectionList as CollectionListContract,
  CollectionListItem,
} from 'api-client'
import { requirePathParameter, requireUserId } from '@/utils/api-gateway'
import { connectDatabase } from '@/utils/database'
import { getCollectionsByOwnerId } from '@/models/collection'
import {
  APIGatewayRequest,
  createApiGatewayHandler,
  setContext,
} from '@/utils/middleware'
import { requirePermissionToUser, UserPermission } from '../user/authorization'

connectDatabase()

export const handler = createApiGatewayHandler(
  setContext('ownerId', (r) => requirePathParameter(r.event, 'userId')),
  setContext('userId', (r) => requireUserId(r.event)),
  requirePermissionToUser(UserPermission.ListCollections),
  async (request: APIGatewayRequest): Promise<CollectionListContract> => {
    const { ownerId } = request
    const foundCollections = await getCollectionsByOwnerId(ownerId)
    return {
      collections: foundCollections.map(
        (collection): CollectionListItem => {
          const { id, name, createdAt } = collection
          return {
            name,
            createdDate: createdAt.toISOString(),
            id,
            links: [],
          }
        },
      ),
    }
  },
)

export default handler
