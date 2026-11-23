import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { BusinessRuleError } from '../subscriptions/subscription-rules';
import { GatewayAdminError } from '../gateway/gateway-admin';

/** Format d'erreur unique : { statusCode, code, message }. */
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse();
    const { status, body } = this.map(exception);
    if (status >= 500) this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    response.status(status).json({ statusCode: status, ...body });
  }

  private map(exception: unknown): { status: number; body: { code: string; message: string | string[] } } {
    if (exception instanceof BusinessRuleError) {
      return { status: 409, body: { code: exception.code, message: exception.message } };
    }
    if (exception instanceof GatewayAdminError) {
      return { status: 502, body: { code: 'GATEWAY_ERROR', message: 'La passerelle n’a pas pu être mise à jour.' } };
    }
    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      const message = typeof res === 'string' ? res : ((res as any).message ?? exception.message);
      return { status: exception.getStatus(), body: { code: httpCode(exception.getStatus()), message } };
    }
    if (exception instanceof QueryFailedError && /unique|duplicate/i.test(exception.message)) {
      return { status: 409, body: { code: 'DUPLICATE', message: 'Cet élément existe déjà (valeur unique en double).' } };
    }
    return { status: 500, body: { code: 'INTERNAL_ERROR', message: 'Erreur interne.' } };
  }
}

function httpCode(status: number): string {
  switch (status) {
    case 400:
      return 'VALIDATION_ERROR';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    default:
      return `HTTP_${status}`;
  }
}
